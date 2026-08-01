import { generateIdentity, noiseStaticFromIdentity, publicKeyToHex } from './crypto/identity';
import {
  MAX_NAME_BYTES,
  PairingError,
  SAS_WORDS,
  base64UrlDecode,
  base64UrlEncode,
  buildPairingPayload,
  decodePairingUri,
  encodePairingUri,
  pairingFingerprint,
  pairingWords,
  parsePairingPayload,
} from './pairing';
import { TrustError, TrustStore } from './trust';

const NOW = 1_700_000_000_000;

describe('pairing payload', () => {
  it('round-trips identity, noise key, and name', () => {
    const keys = generateIdentity();
    const parsed = parsePairingPayload(buildPairingPayload(keys, 'Ayo'));

    expect(publicKeyToHex(parsed.identityKey)).toBe(publicKeyToHex(keys.publicKey));
    expect(publicKeyToHex(parsed.noiseKey)).toBe(
      publicKeyToHex(noiseStaticFromIdentity(keys).publicKey),
    );
    expect(parsed.name).toBe('Ayo');
  });

  it('derives the same noise key from the same identity every time', () => {
    const keys = generateIdentity();
    expect(publicKeyToHex(noiseStaticFromIdentity(keys).publicKey)).toBe(
      publicKeyToHex(noiseStaticFromIdentity(keys).publicKey),
    );
  });

  it('derives a noise key that is not the identity key', () => {
    const keys = generateIdentity();
    expect(publicKeyToHex(noiseStaticFromIdentity(keys).publicKey)).not.toBe(
      publicKeyToHex(keys.publicKey),
    );
  });

  /**
   * The substitution the payload signature exists to stop: a MITM forwards the
   * victim's real identity key alongside its own Noise key, so the identity
   * fingerprint the two humans compare still matches.
   */
  it('rejects a payload whose noise key was swapped for an attacker key', () => {
    const victim = generateIdentity();
    const attacker = generateIdentity();
    const payload = buildPairingPayload(victim, 'Victim');
    payload.set(noiseStaticFromIdentity(attacker).publicKey, 33);

    expect(() => parsePairingPayload(payload)).toThrow(PairingError);
  });

  it('rejects a payload whose identity key was swapped', () => {
    const payload = buildPairingPayload(generateIdentity(), 'Victim');
    payload.set(generateIdentity().publicKey, 1);
    expect(() => parsePairingPayload(payload)).toThrow(PairingError);
  });

  it('rejects a payload whose name was edited', () => {
    const payload = buildPairingPayload(generateIdentity(), 'Ayo');
    payload[66] = 'X'.charCodeAt(0);
    expect(() => parsePairingPayload(payload)).toThrow(PairingError);
  });

  it('rejects a truncated payload', () => {
    const payload = buildPairingPayload(generateIdentity(), 'Ayo');
    expect(() => parsePairingPayload(payload.subarray(0, 40))).toThrow(PairingError);
  });

  it('rejects a payload with a declared length that does not match', () => {
    const payload = buildPairingPayload(generateIdentity(), 'Ayo');
    payload[65] = 30; // claim a longer name than the buffer holds
    expect(() => parsePairingPayload(payload)).toThrow(PairingError);
  });

  it('rejects an unknown payload version', () => {
    const payload = buildPairingPayload(generateIdentity(), 'Ayo');
    payload[0] = 99;
    expect(() => parsePairingPayload(payload)).toThrow(/version/);
  });

  it('refuses to build with an oversized name', () => {
    expect(() => buildPairingPayload(generateIdentity(), 'x'.repeat(MAX_NAME_BYTES + 1))).toThrow(
      PairingError,
    );
  });

  it('handles an empty name and multi-byte characters', () => {
    const keys = generateIdentity();
    expect(parsePairingPayload(buildPairingPayload(keys, '')).name).toBe('');
    expect(parsePairingPayload(buildPairingPayload(keys, 'Ayşe 🌐')).name).toBe('Ayşe 🌐');
  });
});

describe('pairing URI', () => {
  it('round-trips through the QR encoding', () => {
    const keys = generateIdentity();
    const payload = buildPairingPayload(keys, 'Scanner');
    const parsed = parsePairingPayload(decodePairingUri(encodePairingUri(payload)));
    expect(parsed.name).toBe('Scanner');
  });

  it('rejects a URI that is not ours', () => {
    expect(() => decodePairingUri('https://example.com/keys')).toThrow(PairingError);
  });

  it('round-trips base64url at every length modulo', () => {
    for (let n = 0; n < 8; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('produces URL-safe output only', () => {
    const payload = buildPairingPayload(generateIdentity(), 'Ayo');
    expect(base64UrlEncode(payload)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects invalid base64url characters', () => {
    expect(() => base64UrlDecode('abc+def')).toThrow(PairingError);
  });
});

describe('short authentication string', () => {
  it('uses a 256-word list, so each word is a clean 8 bits', () => {
    expect(SAS_WORDS.length).toBe(256);
    expect(new Set(SAS_WORDS).size).toBe(256);
  });

  it('is stable for the same contact', () => {
    const payload = parsePairingPayload(buildPairingPayload(generateIdentity(), 'Ayo'));
    expect(pairingWords(payload)).toEqual(pairingWords(payload));
    expect(pairingWords(payload)).toHaveLength(6);
  });

  it('differs between two identities', () => {
    const a = parsePairingPayload(buildPairingPayload(generateIdentity(), 'A'));
    const b = parsePairingPayload(buildPairingPayload(generateIdentity(), 'B'));
    expect(pairingWords(a)).not.toEqual(pairingWords(b));
    expect(pairingFingerprint(a)).not.toBe(pairingFingerprint(b));
  });

  it('does not depend on the display name, which is not authenticated data', () => {
    const keys = generateIdentity();
    const asAyo = parsePairingPayload(buildPairingPayload(keys, 'Ayo'));
    const asOther = parsePairingPayload(buildPairingPayload(keys, 'Someone Else'));
    expect(pairingWords(asAyo)).toEqual(pairingWords(asOther));
  });
});

describe('TrustStore', () => {
  const paired = (name: string) => parsePairingPayload(buildPairingPayload(generateIdentity(), name));

  it('stores and looks up a contact by either key', () => {
    const store = new TrustStore();
    const payload = paired('Ayo');
    const contact = store.pair(payload, NOW);

    expect(store.byIdentity(payload.identityKey)).toBe(contact);
    expect(store.byNoiseKey(payload.noiseKey)).toBe(contact);
    expect(store.isTrusted(payload.identityKey)).toBe(true);
    expect(contact.fingerprint).toBe(pairingFingerprint(payload));
  });

  it('does not trust a key it has never been shown', () => {
    const store = new TrustStore();
    store.pair(paired('Ayo'), NOW);
    expect(store.isTrusted(generateIdentity().publicKey)).toBe(false);
  });

  it('is idempotent for a repeat scan of the same person', () => {
    const store = new TrustStore();
    const payload = paired('Ayo');
    store.pair(payload, NOW);
    store.pair(payload, NOW + 1000);
    expect(store.size).toBe(1);
  });

  /**
   * Silent re-pinning is how a messenger gets MITM'd after the fact: an
   * attacker who can inject one pairing gets to become the contact. Changing a
   * key has to be an explicit act with the fingerprint back on screen.
   */
  it('refuses to re-pin a known identity to a new key', () => {
    const store = new TrustStore();
    const keys = generateIdentity();
    store.pair(parsePairingPayload(buildPairingPayload(keys, 'Ayo')), NOW);

    const swapped = parsePairingPayload(buildPairingPayload(keys, 'Ayo'));
    swapped.noiseKey = noiseStaticFromIdentity(generateIdentity()).publicKey;

    expect(() => store.pair(swapped, NOW)).toThrow(TrustError);
    expect(store.byIdentity(keys.publicKey)!.noiseKey).not.toEqual(swapped.noiseKey);
  });

  it('allows an explicit re-pair after the user re-scans', () => {
    const store = new TrustStore();
    const keys = generateIdentity();
    store.pair(parsePairingPayload(buildPairingPayload(keys, 'Ayo')), NOW);

    const swapped = parsePairingPayload(buildPairingPayload(keys, 'Ayo'));
    swapped.noiseKey = noiseStaticFromIdentity(generateIdentity()).publicKey;

    const contact = store.repair(swapped, NOW + 1);
    expect(contact.noiseKey).toEqual(swapped.noiseKey);
    expect(store.size).toBe(1);
  });

  it('refuses to bind one noise key to two identities', () => {
    const store = new TrustStore();
    const first = paired('First');
    store.pair(first, NOW);

    const second = paired('Second');
    second.noiseKey = first.noiseKey;
    expect(() => store.pair(second, NOW)).toThrow(TrustError);
  });

  it('forgets a contact completely, including its noise-key index', () => {
    const store = new TrustStore();
    const payload = paired('Ayo');
    store.pair(payload, NOW);

    expect(store.forget(payload.identityKey)).toBe(true);
    expect(store.byNoiseKey(payload.noiseKey)).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.forget(payload.identityKey)).toBe(false);
  });

  it('survives a serialise/restore cycle', () => {
    const store = new TrustStore();
    const payload = paired('Ayo');
    store.pair(payload, NOW);

    const restored = TrustStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    expect(restored.size).toBe(1);
    expect(restored.byNoiseKey(payload.noiseKey)!.name).toBe('Ayo');
    expect(restored.byIdentity(payload.identityKey)!.pairedAt).toBe(NOW);
  });

  it('updates a display name without touching the keys', () => {
    const store = new TrustStore();
    const keys = generateIdentity();
    store.pair(parsePairingPayload(buildPairingPayload(keys, 'Ayo')), NOW);
    const renamed = store.pair(parsePairingPayload(buildPairingPayload(keys, 'Ayo K.')), NOW + 1);
    expect(renamed.name).toBe('Ayo K.');
    expect(store.size).toBe(1);
  });
});
