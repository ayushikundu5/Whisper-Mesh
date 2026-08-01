# Privacy policy

Last updated: 1 August 2026

Whisper Mesh has no servers. There is no account to create, nothing to log in
to, and no company holding your messages. This policy is short because there is
genuinely very little to describe.

## What leaves your phone

Only two things, and both go directly to other phones over Bluetooth — never to
us, because there is no "us" to send them to.

**Public channel messages.** Anyone running the app within range can read these,
and so can any phone that relays them onward. They are signed with your key, so
nobody can post under your name, but they are **not** encrypted. Treat the
public channel as speaking out loud in a room.

**Private messages.** Encrypted end to end between you and one contact you
paired with in person. Phones that relay them carry ciphertext and an 8-byte
routing tag that changes for every single message; they cannot read the content
and cannot tell that two messages belong to the same conversation.

## What stays on your phone

Your identity key, your contacts, and your message history. The identity key is
held in the platform keystore (Android Keystore / iOS Keychain), marked so it is
never included in a cloud or device-to-device backup.

Message history and contacts are stored in an app-private database. **This
database is not separately encrypted.** It is protected from other apps by the
operating system, but not from someone holding your unlocked phone. We would
rather say this than imply a protection that is not there.

## What we deliberately do not do

- No analytics, telemetry, or crash reporting. No third-party SDK of any kind.
- No advertising identifiers.
- No location. The Bluetooth scanning permission is declared
  `neverForLocation`, and both location permissions are blocked in the app
  manifest, so the app cannot access your position even if it were asked to.
- No address book access. Contacts exist only because you scanned a code.

## What is visible to someone nearby

Being honest about this matters more than the rest of the policy.

A phone running Whisper Mesh advertises over Bluetooth so other phones can find
it. That advertisement carries a random identifier that changes roughly every
fifteen minutes and is not derived from your identity. It does **not** carry
your name or your key.

Someone with a Bluetooth scanner within range can nonetheless tell that a device
is running this app, and can see how many such devices are around. Message
timing and volume are also visible to any phone relaying them. **Whisper Mesh
protects the content of your private messages; it does not hide that you are
using it.**

## Deleting your data

Settings → **Erase everything** deletes your identity key, your contacts, and
every message on the device. It is immediate and irreversible, and there is
nothing to request from us afterwards, because we never had a copy.

Messages already relayed to other phones cannot be recalled — they are on those
devices, and they expire there on their own schedule.

## Children

Whisper Mesh is not directed at children and collects nothing from anyone.

## Security status

This project has not had an external security review. The cryptography is
standard and the design decisions are documented in the repository, but
documented is not the same as audited. Please do not rely on this app in a
situation where being read or identified would put you at risk.

## Contact

Issues and questions: the project's public repository.
