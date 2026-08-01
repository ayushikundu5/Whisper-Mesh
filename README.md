# ⚡ Whisper Mesh

> **Decentralized, Serverless, Off-Grid P2P Mesh Messaging Over Bluetooth Low Energy (BLE)**

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/ayushikundu5/Whisper-Mesh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![React Native](https://img.shields.io/badge/React%20Native-0.86-61dafb)](https://reactnative.dev/)
[![Expo SDK](https://img.shields.io/badge/Expo%20SDK-57-black)](https://expo.dev/)
[![Tests](https://img.shields.io/badge/Protocol%20Tests-192%20passed-success)](packages/core)
[![Security Status](https://img.shields.io/badge/Security-Pre--Audit-orange)](#-threat-model--cryptographic-guarantees)

Whisper Mesh is a zero-infrastructure, peer-to-peer mesh messaging system operating entirely over **Bluetooth Low Energy (BLE)**. Mobile devices discover each other automatically and relay encrypted messages hop-to-hop across a distributed mesh topology — **with no internet access, no cellular connectivity, and zero central servers**.

Designed specifically for dead zones, subterranean spaces, crowded stadiums, music festivals, natural disaster scenarios, power grid failures, and remote wilderness adventures.

---

> [!WARNING]
> **Security Status: Pre-Audit Phase**
> This project has not yet undergone an external security audit. It is built for resilient connectivity in dead zones. **Do not rely on it in high-risk environments where physical or digital compromise carries critical risk.** See the [Threat Model](#-threat-model--cryptographic-guarantees) section for detailed cryptographic boundaries and non-claims.

---

## 🌟 Key Highlights

- 📡 **True Off-Grid Mesh Relay**: Relay messages hop-to-hop across multiple intermediate devices using TTL-controlled store-and-forward flooding (`MAX_TTL = 7`).
- 🔐 **End-to-End Encryption (Noise IK)**: Cryptographically secured private 1:1 DMs utilizing `Noise_IK_25519_ChaChaPoly_SHA256`. No unauthenticated key exchanges or TOFU vulnerabilities.
- 🤝 **In-Person Out-of-Band Pairing**: Out-of-band QR code exchange with 6-word Short Authentication String (SAS) fingerprint confirmation to mathematically eliminate MITM attacks.
- ⚡ **Pure TypeScript Protocol Core (`@whisper/core`)**: Zero React Native or platform dependencies in the core. Allows simulating a 20-node lossy, partitioned, hostile mesh network in Jest in under 14 seconds!
- 🔋 **Smart Battery Duty-Cycling**: Dynamic power-management policy (`power/dutyCycle.ts`) adjusts BLE scanning/advertising based on real-time battery status and peer density.
- 📱 **Custom Android Native Radio Module (`whisper-ble`)**: Kotlin-based Expo native module implementing BLE Peripheral advertising and GATT server role alongside central scanning.
- 🎨 **Modern Native UI**: Dual Light/Dark dynamic theme system built with Expo, React Navigation 7, and SVG QR rendering.

---

## 🚦 Project & Hardware Milestone Status

| Milestone | Scope & Features | Status | Verification Detail |
| :--- | :--- | :---: | :--- |
| **M0** | Protocol Core & SimNet | ✅ Complete | 192 automated unit/simulation tests passed in Jest (0 hardware dependencies) |
| **M1** | Two-Phone Hardware Link | ✅ Verified | Tested on real Android hardware: Discovery, GATT server, 1-hop delivery |
| **M2** | Multi-Hop Mesh Relaying | 🔨 In Progress | Simulated in `@whisper/core`; awaiting 3rd hardware device field test |
| **M3** | Noise IK Sessions & QR DM | ✅ Complete | 94 crypto/session tests passed; live hardware E2EE handshake confirmed |
| **M4** | Background Service & Battery | 🔨 In Progress | Foreground service + duty-cycle active; long-term battery profiling underway |
| **M5** | Product & Store Readiness | 🔨 In Progress | App UI, store listing, data safety declaration, & privacy policy complete |

---

## 🏛 Architecture & Protocol Design

Whisper Mesh is organized as a monorepo splitting protocol logic strictly from device/platform bindings.

```
                  ┌─────────────────────────────────────────┐
                  │          React Native App UI            │
                  │   (Screens, State, SQLite, Keystore)    │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────▼────────────────────┐
                  │       @whisper/app (Device Layer)       │
                  │ (BleTransport.ts, whisper-ble Native)   │
                  └────────────────────┬────────────────────┘
                                       │  L0 Transport Interface
      ═════════════════════════════════╪═════════════════════════════════
                                       │  Pure TypeScript (@whisper/core)
                  ┌────────────────────▼────────────────────┐
                  │        Messenger / Trust Store          │
                  │   (Ed25519 Identity, QR Pairing, SAS)   │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────▼────────────────────┐
                  │     L3: E2EE Noise_IK DM Sessions       │
                  │  (X25519, ChaCha20-Poly1305, SHA-256)   │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────▼────────────────────┐
                  │      L2: Mesh Routing & Relaying        │
                  │  (TTL Flooding, Bloom Dedup, Gossip)    │
                  └────────────────────┬────────────────────┘
                                       │
                  ┌────────────────────▼────────────────────┐
                  │    L1: Link Layer (Fragmentation)       │
                  │   (MTU Slicing, Per-Peer Buffer Limits) │
                  └─────────────────────────────────────────┘
```

### 🔒 The 7 Load-Bearing Architectural Rules

Every core rule is backed by explicit regression test suites to prevent security or performance decay:

1. **Zero React Native Imports in Core**: `@whisper/core` must never import `react-native` or platform code. Entire protocol runs in standard Node.js.
2. **Verify Signature Before Deduplication**: Signatures are checked *strictly before* touching the seen-set cache (`mesh.ts`). Prevents cache-poisoning attack where fake signatures suppress legitimate messages.
3. **Comprehensive Header Signing**: Signatures cover `type`, `flags`, `msgId`, `sender`, `timestamp`, and `payload`. Excludes only mutable 2-byte TTL/version. Prevents sender impersonation attacks.
4. **Strict Noise IK Handshake (No TOFU)**: Handshakes require prior static key possession obtained via in-person QR pairing. No unauthenticated key exchanges permitted.
5. **Pinned Trust Store**: Public keys tied to contacts cannot be silently overwritten. Re-keying requires an explicit `repair()` user action.
6. **Ephemeral DM Signatures**: Direct Messages and Handshakes sign wire frames using a rotating 15-minute ephemeral keypair (`EPHEMERALLY_SIGNED`). Prevents BLE relay eavesdroppers from building traffic flow graphs.
7. **Strict Upper Bounds on Memory**: Seen-sets, outboxes, reassembly buffers, and tag indices are strictly capped to mitigate resource-exhaustion DoS attacks.

---

## 📄 Protocol Wire Frame Format

Frames consist of a 2-byte mutable header prefix followed by an immutable, Ed25519-signed region.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Version (1B) |    TTL (1B)   |   Type (1B)   |   Flags (1B)  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       Message ID (16 Bytes)                   +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                     Sender Public Key (32B)                   +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     Timestamp (8 Bytes - ms)                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload (...)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                     Ed25519 Signature (64B)                   +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### Frame Types Breakdown
- `1: ChannelMessage` - Public broadcast message signed by identity key.
- `2: DirectMessage` - Encrypted DM payload routed via directional HMAC tags.
- `3: GossipDigest` - Bloom filter digest of held message IDs for efficient mesh sync.
- `4: GossipRequest` - Explicit request for missing message IDs.
- `5: HandshakeInit` - Noise IK initiation payload (Message 1).
- `6: HandshakeResponse` - Noise IK response payload (Message 2).

---

## 💻 Tech Stack

### Protocol Core (`packages/core`)
- **Language**: TypeScript 5.7 (Strict Mode, `noUncheckedIndexedAccess`)
- **Testing Framework**: Jest 30 (`ts-jest`), Deterministic Radio Simulator (`SimNet`)
- **Crypto Primitives**: `@noble/curves` (Ed25519, X25519), `@noble/ciphers` (ChaCha20-Poly1305), `@noble/hashes` (SHA-256, HMAC)

### Device & App (`packages/app`)
- **Framework**: React Native 0.86 / Expo SDK 57
- **Native Modules**: Local Kotlin Expo Module (`modules/whisper-ble`), `react-native-ble-plx`
- **Database & Storage**: `expo-sqlite` (Messages & Contacts), `expo-secure-store` (Keystore Seeds)
- **UI & State**: Custom Theme System (Dark/Light), React Navigation 7, `react-native-qrcode-svg`, `expo-camera`

---

## ⚡ BLE Hardware & OS Optimizations

- **31-Byte Advertisement Constraint**: Standard BLE advertisements are restricted to 31 bytes. Whisper Mesh packages the ephemeral peer handle inside manufacturer data under SIG-reserved ID `0xFFFF` to ensure compatibility without triggering `ADVERTISE_FAILED_DATA_TOO_LARGE`.
- **Android Scan Throttling Workaround**: Android limits scan triggers to 5 starts per 30-second window. `BleTransport` enforces a floor cycle of 6.5s to sustain active duty-cycling without getting throttled.
- **Custom Kotlin GATT Server**: Extends `react-native-ble-plx` by adding full GATT Server & Advertising capabilities via `WhisperBleModule.kt` and a persistent Android Foreground Service (`WhisperForegroundService.kt`).
- **iOS Background Awareness**: iOS hides advertisement service data when in the background. Whisper Mesh automatically identifies iOS devices and operates them as active foreground nodes or leaf participants.

---

## 🛠️ Quick Start & Installation

### Prerequisites
- **Node.js**: `v20.0.0` or higher
- **JDK**: **Java 21 (Mandatory)** *(JDK 24+ or Studio JBR 25 causes `prefab` stderr warnings that break Gradle builds)*
- **Android SDK**: Platform 36, Build-Tools 36
- **Path Warning**: Windows users must build from a path containing **no spaces** (e.g. `C:\Whisper-Mesh`).

### 1. Test Protocol Core (No Hardware Needed)
Run the entire 192-test protocol suite in Node.js:

```bash
# Clone the repository
git clone https://github.com/ayushikundu5/Whisper-Mesh.git
cd Whisper-Mesh

# Install & test protocol core
npm install
npm test

# Run typechecks
npm run typecheck
```

To run a single test suite during development:
```bash
npm test --workspace packages/core -- src/session.test.ts
```

### 2. Build & Run Android App

```bash
cd packages/app

# Install dependencies
npm install

# Prebuild native code
npx expo prebuild --platform android

# Build Standalone Release APK
cd android
./gradlew assembleRelease
```
> The generated standalone APK is located at: `packages/app/android/app/build/outputs/apk/release/app-release.apk`

---

## 📱 Hardware Testing Procedure (2+ Devices)

1. **Install APK** on two physical Android phones.
2. **Grant Nearby Devices Permission**: Ensure `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, and `BLUETOOTH_ADVERTISE` permissions are granted.
3. **Configure User Name**: Set display name in Settings prior to scanning.
4. **Verify Connectivity**: Status card should display `1 device in range`.
5. **Test Public Channel ("Everyone nearby")**: Post a broadcast message to verify GATT link and signature verification.
6. **Pair Devices**:
   - Open **Pairing Screen** on both devices to display QR code and 6 confirmation words.
   - Scan each other's QR code using the in-app camera.
   - Verify that the 6 Short Authentication String (SAS) words match on both screens.
7. **Send Encrypted DM**: Initiate private chat. Upon completion of the Noise IK handshake, status shifts from fingerprint to `Connected`.

---

## 📂 Repository Layout

```
Whisper-Mesh/
├── .github/                    # CI/CD Workflows
├── packages/
│   ├── core/                   # Pure TypeScript Mesh Protocol
│   │   ├── src/
│   │   │   ├── crypto/         # Ed25519 identity & Noise IK E2EE
│   │   │   ├── net/            # Connection scheduling & peer selection
│   │   │   ├── power/          # Dynamic battery duty-cycling engine
│   │   │   ├── testing/        # SimNet deterministic radio simulator
│   │   │   ├── bloom.ts        # Bloom filter digest generator for gossip
│   │   │   ├── frame.ts        # Binary frame encoding & Ed25519 signing
│   │   │   ├── link.ts         # MTU fragmentation & per-peer queuing
│   │   │   ├── lru.ts          # Bounded LRU deduplication cache
│   │   │   ├── mesh.ts         # TTL flood routing & store-and-forward
│   │   │   ├── messenger.ts    # Main app-facing messenger orchestrator
│   │   │   ├── pairing.ts      # Out-of-band QR payload & SAS 6-word gen
│   │   │   ├── session.ts      # E2EE Noise session state & tag router
│   │   │   ├── transport.ts    # L0 hardware abstraction interface
│   │   │   ├── trust.ts        # Pinned public-key identity store
│   │   │   └── types.ts        # Protocol frame constants & interfaces
│   │   ├── jest.config.js      # Core test runner configuration
│   │   └── package.json        # Protocol core package manifest
│   └── app/                    # React Native Device & UI Application
│       ├── modules/
│       │   └── whisper-ble/    # Native Android (Kotlin) & iOS (Swift) BLE module
│       ├── src/
│       │   ├── ble/            # BleTransport implementation & BLE constants
│       │   ├── screens/        # Channel, Chat, Pair, & Settings UI screens
│       │   ├── state/          # MeshProvider React Context & lifecycle
│       │   ├── storage/        # SQLite message store & Keystore seed storage
│       │   └── ui/             # Dynamic Light/Dark UI theme system
│       ├── store/              # Play Store listing, checklist & privacy policy
│       ├── App.tsx             # Root application navigation shell
│       └── package.json        # Mobile application package manifest
├── package.json                # Monorepo workspace configuration
├── CLAUDE.md                   # Repository guidelines
└── README.md                   # Master project documentation
```

---

## 🛡️ Threat Model & Cryptographic Guarantees

### What Whisper Mesh Guarantees
- **Message Confidentiality & Integrity**: Direct Messages use Noise IK encryption. Relays cannot decrypt message contents.
- **Impersonation Prevention**: Public messages are signed with Ed25519 identity keys. Frame headers cover sender public keys to prevent forging.
- **MITM Resistance**: QR pairing coupled with 6-word SAS confirmation prevents key-substitution attacks during pairing.
- **Metadata Protection for Relays**: DMs are signed with ephemeral rotating keys. Relays see only 8-byte HMAC tags (`HMAC(directional_key, counter)`), preventing passive traffic flow analysis.

### What Is Not Claimed (Pre-Audit Boundaries)
- **Metadata Anonymity from Local Radio Observers**: BLE advertisements broadcast over local spectrum. A local radio sniffer can detect that Whisper Mesh is running.
- **At-Rest Database Encryption**: Local SQLite database is stored in application sandbox (SQLCipher planned post-audit).
- **External Security Audit**: Codebase is pre-audit. Use responsibly in off-grid situations.

---

## 👤 Author & Credits

Created and maintained by **Ayushi Kundu** ([@ayushikundu5](https://github.com/ayushikundu5)).

Contributions and pull requests welcome! Please read [`CLAUDE.md`](CLAUDE.md) for contribution guidelines and testing requirements.

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.
