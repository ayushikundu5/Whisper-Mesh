import { SerialisedContact, TrustStore } from '@whisper/core';
import * as SQLite from 'expo-sqlite';

/**
 * Local persistence: contacts and message history.
 *
 * WHAT IS AND IS NOT STORED. Message *plaintext* is stored, because a messenger
 * that forgets your conversation on every restart is not one anyone uses. Noise
 * *session keys* are not: they live in memory only, and a restart means a fresh
 * handshake. That costs one round trip and buys the property that a phone
 * powered off holds no key that decrypts anything it has already forwarded.
 *
 * This database is not itself encrypted — SQLCipher is post-audit work, and
 * claiming at-rest encryption without it would be worse than not claiming it.
 * On both platforms the file sits in app-private storage, which protects it
 * from other apps but not from someone holding an unlocked phone. The identity
 * seed is the one secret that gets stronger treatment; see `identity.ts`.
 */

const DB_NAME = 'whisper.db';

export interface StoredMessage {
  id: string;
  /** Identity key hex of the other party, or `#channel` for the public feed. */
  conversation: string;
  /** True if we wrote it. */
  outbound: boolean;
  body: string;
  sentAt: number;
  /** Local receipt time. Never trust the sender's clock for ordering. */
  receivedAt: number;
}

let handle: SQLite.SQLiteDatabase | null = null;

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (handle) return handle;
  const db = await SQLite.openDatabaseAsync(DB_NAME);

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS contacts (
      identity_key TEXT PRIMARY KEY NOT NULL,
      noise_key    TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      paired_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY NOT NULL,
      conversation TEXT NOT NULL,
      outbound     INTEGER NOT NULL,
      body         TEXT NOT NULL,
      sent_at      INTEGER NOT NULL,
      received_at  INTEGER NOT NULL
    );

    -- Ordered by local receipt, not the sender's claimed timestamp: a peer can
    -- put anything in that field, and a message that jumps to the top of a
    -- conversation because someone lied about the time is a spoofing surface.
    CREATE INDEX IF NOT EXISTS messages_by_conversation
      ON messages (conversation, received_at);

    -- Interface preferences only. Nothing here is secret and nothing here is
    -- protocol state, which is why it sits in the plain database rather than
    -- the keystore, and why wipeEverything leaves it alone.
    CREATE TABLE IF NOT EXISTS prefs (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  handle = db;
  return db;
}

export const CHANNEL_CONVERSATION = '#channel';

// ---------------------------------------------------------------- contacts

export async function loadTrustStore(): Promise<TrustStore> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<{
    identity_key: string;
    noise_key: string;
    name: string;
    paired_at: number;
  }>('SELECT identity_key, noise_key, name, paired_at FROM contacts');

  const entries: SerialisedContact[] = rows.map((row) => ({
    identityKey: row.identity_key,
    noiseKey: row.noise_key,
    name: row.name,
    pairedAt: row.paired_at,
  }));
  return TrustStore.fromJSON(entries);
}

export async function persistTrustStore(trust: TrustStore): Promise<void> {
  const db = await openDatabase();
  const contacts = trust.toJSON();

  await db.withTransactionAsync(async () => {
    // Full replace. The contact list is tens of rows at most, and a diff would
    // be more code than it saves — with more ways to leave a stale key trusted.
    await db.runAsync('DELETE FROM contacts');
    for (const contact of contacts) {
      await db.runAsync(
        'INSERT INTO contacts (identity_key, noise_key, name, paired_at) VALUES (?, ?, ?, ?)',
        contact.identityKey,
        contact.noiseKey,
        contact.name,
        contact.pairedAt,
      );
    }
  });
}

// ---------------------------------------------------------------- messages

export async function saveMessage(message: StoredMessage): Promise<void> {
  const db = await openDatabase();
  await db.runAsync(
    `INSERT OR IGNORE INTO messages (id, conversation, outbound, body, sent_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    message.id,
    message.conversation,
    message.outbound ? 1 : 0,
    message.body,
    message.sentAt,
    message.receivedAt,
  );
}

export async function loadConversation(
  conversation: string,
  limit = 500,
): Promise<StoredMessage[]> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<{
    id: string;
    conversation: string;
    outbound: number;
    body: string;
    sent_at: number;
    received_at: number;
  }>(
    `SELECT * FROM messages WHERE conversation = ?
     ORDER BY received_at DESC LIMIT ?`,
    conversation,
    limit,
  );

  return rows
    .map((row) => ({
      id: row.id,
      conversation: row.conversation,
      outbound: row.outbound === 1,
      body: row.body,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
    }))
    .reverse();
}

export async function conversationSummaries(): Promise<
  Array<{ conversation: string; body: string; receivedAt: number }>
> {
  const db = await openDatabase();
  return db.getAllAsync(`
    SELECT conversation, body, MAX(received_at) AS receivedAt
    FROM messages GROUP BY conversation ORDER BY receivedAt DESC
  `);
}

/** Everything, including the identity-linked contact rows. Used by "panic". */
export async function wipeEverything(): Promise<void> {
  const db = await openDatabase();
  await db.execAsync('DELETE FROM messages; DELETE FROM contacts;');
}
