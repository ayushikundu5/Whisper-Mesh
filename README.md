# Whisper Mesh

Offline messaging over Bluetooth LE. Phones discover each other and relay messages hop-to-hop, with no internet, no cell service, and no servers.

> **Security status: pre-audit.** This project has had no external security review. It is built for connectivity in dead zones — festivals, stadiums, campsites, outages. **Do not rely on it in a situation where being read or identified carries real risk.** See [Threat model](#threat-model).

## Status

**The protocol is complete and tested in simulation. The app now runs on real hardware, and two phones have exchanged an encrypted message.**

| Milestone | State |
|---|---|
| M0 — protocol in simulation | ✅ complete — 192 tests, no hardware |
| M1 — two phones, one frame | ✅ **verified on hardware** — discovery, GATT, and delivery between two Android phones |
| M2 — real multi-hop mesh | 🔨 relay, gossip sync and connection policy tested in simulation; **needs a third phone to verify** |
| M3 — Noise sessions, QR pairing, DMs | ✅ complete — 94 tests, and a live session between two paired phones |
| M4 — background service, battery | 🔨 duty-cycle policy tested; foreground service runs; **battery cost over hours unmeasured** |
| M5 — product, Play Store | 🔨 app, listing, privacy policy written; **debug-signed only, nothing submitted** |

What is *not* yet verified, precisely: **relaying**. Two phones prove direct delivery. The mesh claim — that a message hops A → B → C when A and C are out of range of each other — needs three devices and has not been run.

## Quick start

```sh
npm install     # packages/core only, seconds
npm test        # 192 tests, no hardware
npm run typecheck
```

Run a single suite while iterating:

```sh
npm test --workspace packages/core -- src/session.test.ts
```

> On Windows PowerShell, `&&` is not a valid separator. Use `;` or the `--workspace` form above.

## Why the core is pure TypeScript

`packages/core` imports nothing from React Native. That is the load-bearing decision of the whole project: a 20-node mesh with packet loss, partitions, and hostile peers runs in Jest on a laptop in ~14 seconds. Every routing, dedup, TTL, session, and power bug gets found before anyone opens Android Studio.

```
packages/core/src/
  types.ts              protocol constants, frame shape, frame types
  frame.ts              wire format; signed vs. mutable header split
  lru.ts  bloom.ts      bounded dedup set; gossip digests
  link.ts               L1 — fragmentation, reassembly, per-peer bounds
  mesh.ts               L2 — TTL flooding, store-and-forward, gossip sync
  session.ts            L3 — Noise sessions over the flood mesh, tag routing
  messenger.ts          app-facing: identity + trust + sessions + mesh
  pairing.ts  trust.ts  QR pairing payload; the trust store
  crypto/identity.ts    Ed25519 identity, frame signing and verification
  crypto/noise.ts       Noise_IK_25519_ChaChaPoly_SHA256
  net/connection.ts     which peers to dial, and when
  power/dutyCycle.ts    how hard to run the radio
  transport.ts          L0 interface — the only thing BLE has to satisfy
  testing/simnet.ts     deterministic radio simulator

packages/app/           radio, storage, UI. No protocol logic.
  index.js              CSPRNG polyfill — must load before anything else
  src/ble/BleTransport.ts   the only file that knows BLE exists
  src/state/MeshProvider.tsx  lifecycle: identity, radio, mesh, sessions
  src/ui/theme.ts       light and dark palettes, style factory
  modules/whisper-ble/  local Expo module: BLE peripheral role (Kotlin)
```

The simulator earns its place: it models loss and partitioning as properties of the *network*, and `flush()` throws if the queue will not drain — so a routing loop or a missing TTL decrement fails a test instead of hanging.

## Building the Android app

`packages/app` is deliberately **not** an npm workspace. It pulls the entire React Native toolchain, and `npm install && npm test` working anywhere is worth more than saving one command.

### Toolchain requirements

Two of these are not optional and both cost hours if missed.

| Requirement | Why |
|---|---|
| Android SDK, platform 36, build-tools 36 | Gradle downloads what is missing |
| **JDK 21** | **Not 25.** AGP runs `prefab` as a separate JVM; JDK 24+ prints a native-access warning to stderr and AGP treats any prefab stderr as fatal. Android Studio's bundled JBR is 25 — set Gradle JDK to 21 explicitly. |
| **A build path with no spaces** | Windows 8.3 shortening rewrites `clang++.exe` to `CLANG_~1.EXE`. Clang picks its C or C++ driver mode from its own filename, so under the short name it links as C and omits libc++ — producing ~20 undefined `operator new` / `__cxa_*` symbols at link time. Use a junction: `mklink /J C:\wm "C:\path with spaces\Whisper-Mesh"`. |
| A physical Android phone | Emulators have no BLE radio |

### Build

```sh
cd packages/app
npm install
npx expo prebuild --platform android   # generates android/, which is gitignored
cd android
./gradlew assembleRelease
```

Output: `packages/app/android/app/build/outputs/apk/release/app-release.apk` (~112 MB, four ABIs, JS bundle embedded).

**Expo Go will not work.** `react-native-ble-plx` and the local `whisper-ble` module are native code; a dev client or release build is required.

Debug builds do **not** embed the JS bundle — they expect Metro and will show "Unable to load script" if it is not running. Use `assembleRelease` for a standalone APK.

> The release variant is signed with the **debug keystore**. Installable on your own devices; not shippable. Generate a real keystore before any store submission.

## Using it — two devices

A BLE mesh cannot be tested with one phone. Two prove direct messaging; three are needed to prove relaying.

1. **Install the same APK on both.** Different signatures cannot be installed over one another.
2. **Grant "Nearby devices".** Android 12+ makes `BLUETOOTH_SCAN`/`CONNECT`/`ADVERTISE` runtime permissions; refused, the scanner returns nothing and advertising fails *silently*.
3. **Set your name first** — on the pairing screen or in Settings. The name is signed into the pairing payload at scan time, so renaming later cannot reach a contact someone has already stored.
4. **Check the status card** reads `1 device in range`. That counts *other* phones, so 1 is correct for a pair. A `Radio problem` banner names the fault if there is one.
5. **Test the public channel first** — "Everyone nearby". No keys involved, so it isolates radio faults from crypto faults.
6. **Pair.** Each phone shows a QR *and its own six confirmation words*. The other phone scans and sees six words in a dialog. **They must match.** If they differ, someone is in between — stop.
7. **Send a private message.** The contact subtitle shows a fingerprint until the Noise handshake completes, then `Connected`.

Both phones must be in the foreground and within about ten metres.

### If they cannot find each other

Bluetooth on; **Nearby devices** granted; both apps foregrounded. Then:

```sh
adb logcat -s ReactNativeJS:V WhisperBle:V AndroidRuntime:E
```

## Design notes worth knowing

### Signature coverage

The frame splits into a 2-byte mutable prefix (`version`, `ttl`) and a signed region covering everything else — `type`, `flags`, `msgId`, **`sender`**, `timestamp`, and payload.

BitChat's headline vulnerability was signing only the payload, leaving `senderPeerID` and `nickname` forgeable, so anyone could impersonate anyone in a public channel. `frame.test.ts` has a test per tampered field, including that exact attack.

TTL is excluded because relays must rewrite it; signing it would break the signature at the first hop. That is safe because TTL asserts nothing about authenticity — and the mesh clamps it to `MAX_TTL` on receipt, which closes the broadcast-storm vector that exclusion would otherwise open.

### Verify before dedup

`mesh.ts` verifies a signature *strictly before* touching the seen set. Reversing these is BitChat's cache-poisoning bug: an attacker mints a frame carrying the id of a message they want suppressed, the node caches that id, and the genuine message is later dropped as a duplicate — censorship with no key material. There is a regression test for it.

### Noise IK, not XX

XX lets two strangers agree a key and *then* compare fingerprints out of band. That is one unauthenticated round trip, and it is where every MITM break in this class of app lives.

IK requires the initiator to already hold the responder's static key, and in this app that key can only have come from a QR pairing. So "no unauthenticated key exchange, ever" stops being a rule people have to remember and becomes something the protocol cannot express: **you cannot handshake with someone you have not met.** IK also hides the initiator's identity from relays, since its static key travels encrypted inside the first message.

The X25519 Noise key is derived from the Ed25519 identity seed through an HMAC rather than converted from it — one keypair used for two algorithms means a flaw in either primitive's use costs you both. The pairing QR carries both keys and is signed by the identity key, and the six confirmation words cover both, so a MITM swapping only the Noise key still produces different words on the two screens.

### What a relay learns from a direct message

A relay sees an 8-byte tag and a ciphertext. The tag is `HMAC(directional key, counter)` — **fresh for every message** — so two messages in one conversation look no more related than two between strangers. Recipients pre-register expected tags, so a non-recipient does one map lookup and zero crypto.

The frame's `sender` field would undo this, so direct messages and handshakes are signed with an **ephemeral** key rotating every 15 minutes, alongside the advertised Bluetooth id. Public channel messages use the real identity key, because attribution there is what stops impersonation.

### The BLE advertisement is 31 bytes

A legacy advertisement holds 31 bytes. Flags take 3 and a 128-bit service UUID takes 18, leaving 10 — and service data keyed by that same UUID would spend 18 more restating it. The peer id therefore rides in **manufacturer data** under company id `0xFFFF` (SIG-reserved for internal use): 2 + 2 + 7 = 11 bytes, in the scan response, while the advertisement carries the UUID that `ScanFilter` matches on.

Getting this wrong fails closed and silently: `ADVERTISE_FAILED_DATA_TOO_LARGE` means the phone scans perfectly while being invisible to everyone else.

### Android counts scan starts, not scan time

Five `startScan` calls in any 30 seconds and the sixth fails. The duty cycle asks for a 1–2 second cycle at full power, which exhausts that budget in five seconds and leaves the phone **advertising but deaf**. `BleTransport` therefore floors the scan cycle at 6.5 s and widens the window to preserve the duty *ratio*, so the power model still holds.

### Battery is a protocol concern

Continuous BLE scanning is the largest power cost, well ahead of crypto. `power/dutyCycle.ts` is pure policy — testable without a battery — and cuts scanning hard while keeping advertising alive: a node that can still be *found* stays part of the mesh even when it has mostly stopped looking.

The density term is the interesting one. In a crowded mesh, anything a node would find by scanning harder a neighbour will relay to it anyway — and a crowd is where battery matters most. Alone, the policy scans harder to get back in. Except on a dying battery, where it deliberately does not: at 4%, staying advertisable for hours is worth more than one more neighbour now.

### Known limitation: no application-level ARQ

A frame arrives only if every fragment does, so per-link delivery is `(1-p)^fragments`. At the 20-byte BLE floor a signed frame is 9 fragments; at 30% loss that is ~4%, and path redundancy does not repair it. Connection-oriented BLE retransmits at the link layer, so this is pessimistic for GATT writes and realistic for anything advertising-based.

Two consequences: MTU negotiation is a reliability feature rather than a throughput tweak, and carrying frames over advertisements would require real ARQ in L1 first.

### What iOS cannot do

Apple drops service data from background advertisements, keeping only the service UUID in an overflow area readable solely by other iOS devices scanning for that exact UUID. **Two backgrounded iPhones cannot discover each other.** No workaround exists.

The mesh therefore runs on Android; on iOS it works in the foreground and a pocketed iPhone is a leaf node, not a relay. The app reports this rather than letting someone believe they are carrying traffic when they are not.

### Other things the simulator cannot see

The 192 tests run in Node, which has `crypto.getRandomValues`. Hermes does not — every key, message id, and nonce comes from it, so `packages/app/index.js` imports `react-native-get-random-values` **before anything else**. Deleting that line is a one-character change that bricks the app at launch with an empty log.

This generalises: everything below the `Transport` interface and everything in the UI is invisible to the suite by design. Both are where the hardware bugs were.

## Contributing

Rules that are load-bearing rather than stylistic, each with a regression test:

1. **Nothing in `packages/core` imports from `react-native`.** Platform APIs go behind `Transport` or into `packages/app`.
2. **Verify before dedup.**
3. **Everything meaningful is inside the signature.**
4. **No unauthenticated key exchange, ever.** No TOFU, no `trustFromFrame()`.
5. **Trust store keys are pinned.** Changing one requires an explicit `repair()`.
6. **Direct messages are signed with an ephemeral key.**
7. **Bounds are security properties** — the seen set, outbox, reassembly buffers, pending handshakes and tag index are all capped.

Conventions: comments explain *why*, tests are named as claims (`it('drops replays rather than re-delivering them')`), strict TypeScript with `noUncheckedIndexedAccess`, and errors on the receive path return null while errors on user input throw.

Add the adversarial test with the feature. The interesting question is rarely "does it work" — it is "what does a hostile peer get to do".

## Threat model

Shipping at **"connectivity, not adversaries."** Architected for more; marketed for exactly this until externally audited.

Three properties are in from the first commit because they cannot be retrofitted without a protocol break:

1. **No unauthenticated key exchange, ever.** Public keys enter the trust store only via out-of-band QR pairing, and Noise IK makes that a property of the protocol rather than a convention. Known identities are key-pinned.
2. **Rotating ephemeral advertising IDs.** A static id in BLE service data turns every user into a trackable beacon. `PeerId` is the ephemeral link handle and is never conflated with the identity key.
3. **A version byte in frame zero**, so a ratchet can land later without a flag day.

**Claimed:** message content is encrypted between paired contacts; nobody can post under someone else's name; a substituted key cannot survive two people comparing six words.

**Not claimed until audited:** metadata resistance, protection from a resourced adversary, or safety for anyone at risk. The app advertises over Bluetooth, so a scanner nearby can tell it is running. Whisper Mesh protects what you say, not the fact that you are saying it.

The message database is also **not encrypted** at rest. SQLCipher is post-audit work, and claiming at-rest encryption without it would be worse than not claiming it.

## License

MIT
