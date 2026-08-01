# Play Store listing

Copy for the Google Play listing. The rule applied throughout: **claim only what
the tests and the threat model support.** An offline messenger that oversells
its privacy attracts exactly the users it will fail.

---

## App name

Whisper Mesh

## Short description (80 characters max)

> Message people nearby with no internet, no signal, and no servers.

79 characters. Leads with the capability, not the privacy, because the
capability is what is actually proven.

## Full description

> **When the network is gone, your phone can still reach the people around you.**
>
> Whisper Mesh passes messages directly between phones over Bluetooth. No
> internet, no mobile signal, no accounts, no servers — the messages hop from
> phone to phone until they arrive.
>
> **Where it helps**
> • Festivals and stadiums, where the towers are saturated
> • Campsites, trails, and boats out of coverage
> • Power cuts and outages
> • Flights, basements, anywhere with no signal
>
> **How it works**
> Your phone finds other phones running Whisper Mesh within about ten metres.
> Anything you send is passed along by every phone in between, so you can reach
> someone further away than your own Bluetooth range — as long as there is a
> chain of people between you.
>
> **Two kinds of message**
> • **Nearby** — a public channel anyone in range can read. Messages are signed,
>   so nobody can post under your name.
> • **Private** — end-to-end encrypted between you and one contact. Pair once by
>   scanning each other's code in person, and you are connected for good.
>
> **Pairing is in person, on purpose**
> There is no way to add a contact remotely. Anything sent over the air could
> have been sent by somebody else; a code you can physically see is the one
> exchange nobody can stand in the middle of.
>
> **About battery**
> Bluetooth scanning uses power. Whisper Mesh watches your battery and eases off
> as it drops — and always keeps your phone findable, so you stay reachable even
> when it has mostly stopped looking. A notification stays visible whenever it
> is relaying, so it can never drain your battery without telling you.
>
> **What we do not claim**
> This app has not had an external security review. Private messages are
> encrypted, but the app does not hide the fact that you are using it, or that
> phones are near each other. Please do not rely on it in a situation where
> being seen using it would put you at risk.
>
> Free, open source, no ads, no tracking, no accounts.

## Category

Communication

## Tags

offline, bluetooth, mesh, messaging, no internet, off-grid

---

## Data safety declaration

Google requires a per-item answer. Ours is unusually short because there is no
server to collect anything into.

| Data type | Collected | Shared | Notes |
|---|---|---|---|
| Name | No | No | The display name never leaves your device except to phones you pair with in person. |
| Messages | No | No | Stored on your device only. There is no server. |
| Contacts | No | No | Paired keys stay on the device. Not read from the system address book. |
| Location | No | No | `BLUETOOTH_SCAN` is declared `neverForLocation`, so the app cannot derive position from it. |
| Device IDs | No | No | The advertised id is random and rotates; it is not a device identifier. |
| Crash logs | No | No | No analytics or crash reporting SDK is bundled. |

**Encryption in transit:** yes, for private messages (Noise IK, X25519 +
ChaCha20-Poly1305). Public channel messages are signed but not encrypted, and
the listing says so.

**Data deletion:** in-app, under Settings → Erase everything. Nothing to request
from us, because we hold nothing.

---

## Permissions, and how to answer the reviewer

Play reviewers ask about each of these. The answers below are the true ones.

**`BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN`**
The entire function of the app. It finds nearby phones and exchanges message
fragments with them. `BLUETOOTH_SCAN` is declared with
`usesPermissionFlags="neverForLocation"`, and both location permissions are
explicitly blocked in the manifest, so the app is structurally incapable of
deriving a position.

**`FOREGROUND_SERVICE_CONNECTED_DEVICE`**
Android suspends the app within minutes of backgrounding, which stops the GATT
server and silently removes the device from the mesh. Since the point of the app
is to keep relaying while it is in a pocket, that is not an acceptable failure.
The service type is the accurate one: it maintains Bluetooth connections to
nearby devices.

**`POST_NOTIFICATIONS`**
For the ongoing relay notification. It is deliberately not dismissable while the
service runs — a background app using the radio should never be invisible.

**`CAMERA`**
Only to scan a pairing QR code. Never opened for any other reason, and the app
has no photo storage permission at all.

---

## Release checklist

Nothing here can be signed off from a simulation. Every item needs hardware.

- [ ] Two physical Android phones exchange a message end to end (M1)
- [ ] Three phones relay a message A → B → C with A and C out of range (M2)
- [ ] Pairing, then an encrypted DM, across two hops (M3)
- [ ] Confirmation words match on both phones, and differ when a key is swapped
- [ ] App backgrounded for 8 hours still relays; measured battery drain recorded
- [ ] Behaviour verified with Bluetooth off, then toggled on mid-session
- [ ] Permission denial paths lead somewhere sensible, not a blank screen
- [ ] `Erase everything` genuinely clears the keystore entry, not just the UI
- [ ] Data safety form matches the table above, item for item
- [ ] Security status in the listing still matches `README.md`
