import { openDatabase } from './db';

/**
 * Interface preferences.
 *
 * Deliberately separate from `identity.ts`, which uses the platform keystore.
 * A theme choice is not a secret, and putting it behind the keystore would mean
 * an unlocked-device check to decide what colour to paint a screen.
 */

export async function loadPreference(key: string): Promise<string | null> {
  const db = await openDatabase();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM prefs WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

export async function savePreference(key: string, value: string): Promise<void> {
  const db = await openDatabase();
  await db.runAsync(
    'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    key,
    value,
    value,
  );
}
