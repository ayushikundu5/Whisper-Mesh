# @whisper/app

The device half: radio, storage, and UI. **No protocol logic lives here.**

Every routing, framing, crypto, and power decision is in `@whisper/core`, where
it runs in Node under test. This package's job is to satisfy the `Transport`
interface with a real radio and to draw the result on a screen. If you find
yourself reaching for a `Frame` in a component, the boundary has been crossed in
the wrong direction.

## Status: compiles, never run

What is confirmed:

- `npm install` succeeds, and `npm run typecheck` passes against the real
  React Native, Expo, `react-native-ble-plx` and React Navigation types.
- `npx expo config --type prebuild` resolves, so `app.json` and its plugins are
  valid.
- `npx expo-modules-autolinking search -p android` finds `whisper-ble` and
  registers `expo.modules.whisperble.WhisperBleModule`, so the local native
  module is wired up correctly.

What is **not** confirmed, and it is the part that matters: none of this code has
executed. No Kotlin has been compiled, no advertisement has been broadcast, no
byte has crossed a radio. Type-correct is a long way from working, and BLE is
notoriously a place where correct-looking code fails on contact with a real
stack.

The release checklist in `store/listing.md` is the list of things that have to be
confirmed on hardware before any of it is believed.

## Why this is not an npm workspace

`packages/core` installs in seconds and its tests need no hardware. Adding this
package to the root workspaces would make every `npm install` at the repository
root pull the entire React Native and Expo toolchain — hundreds of megabytes,
with a real chance of failing on a machine that has no Android SDK.

The root `npm install && npm test` running the full protocol suite anywhere is
worth more than saving one command here.

## Running it

Requires the Android SDK and a physical device. `react-native-ble-plx` and the
local `whisper-ble` module are native, so **Expo Go will not work** — a dev
client build is required.

```sh
cd packages/app
npm install
npx expo prebuild --clean      # generates android/ and ios/
npx expo run:android           # builds and installs on a connected device
```

A BLE mesh cannot be tested with one device. You need two, and to see a relay
work, three — with the two endpoints physically out of range of each other.

## Layout

```
App.tsx                     navigation shell
src/ble/constants.ts        the BLE wire contract: UUIDs, advertisement layout
src/ble/BleTransport.ts     Transport over BLE. The only file that knows BLE exists.
src/state/MeshProvider.tsx  lifecycle: identity, radio, mesh, sessions
src/storage/identity.ts     the Ed25519 seed, in the platform keystore
src/storage/db.ts           contacts and message history
src/screens/                UI
modules/whisper-ble/        local Expo module: the BLE peripheral role
store/                      Play Store listing, privacy policy, release checklist
```

## The peripheral-role problem

`react-native-ble-plx` implements the central role well and the peripheral role
not at all. A phone that can only dial out and never accept cannot form a mesh
with another phone in the same state, so `modules/whisper-ble` exists to add the
advertiser and the GATT server.

That module is where the platforms stop being equivalent:

- **Android** advertises and runs a GATT server in the background behind a
  foreground service. The mesh works.
- **iOS** drops service data from background advertisements, keeping only the
  service UUID in an overflow area that only other iOS devices scanning for that
  exact UUID can see. Two backgrounded iPhones cannot discover each other. This
  is an OS restriction with no workaround.

So on iOS the mesh works in the foreground, and a pocketed iPhone is a leaf node
rather than a relay. `capabilities()` reports this and the UI says so, rather
than letting someone believe they are carrying traffic when they are not.
