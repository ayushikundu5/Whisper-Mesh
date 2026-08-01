import {
  ConnectionManager,
  DeviceState,
  DutyCycleController,
  PeerId,
  PeerUnreachableError,
  RadioPlan,
  Transport,
} from '@whisper/core';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleError, BleManager, Device, Subscription } from 'react-native-ble-plx';
import WhisperBle from '../../modules/whisper-ble/src';
import {
  ATT_HEADER_BYTES,
  CONNECT_TIMEOUT_MS,
  DEFAULT_MTU,
  INBOX_CHARACTERISTIC_UUID,
  MANUFACTURER_ID,
  MAX_CONNECTIONS,
  OUTBOX_CHARACTERISTIC_UUID,
  PEER_ID_BYTES,
  PEER_ID_ROTATION_MS,
  PREFERRED_MTU,
  SERVICE_UUID,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodeAdvertisement,
  encodeAdvertisement,
} from './constants';

/**
 * L0 for real hardware: the BLE implementation of `Transport`.
 *
 * This is the only file in the project that knows BLE exists. Everything above
 * it — fragmentation, dedup, TTL, flooding, sessions — was written and tested
 * against `SimTransport` in Node, and does not change here. If a message fails
 * to arrive on a phone but the simulation says it should have, the bug is in
 * this file.
 *
 * A phone plays both roles at once:
 *
 *   central     scans, dials, writes to the peer's INBOX, subscribes to OUTBOX
 *   peripheral  advertises, accepts, receives INBOX writes, notifies OUTBOX
 *
 * Which role a given link uses is decided by `ConnectionManager` and is
 * invisible above this layer — `send()` looks the same either way.
 */

/**
 * How long to wait for the adapter before telling the user. Long enough that a
 * phone still bringing Bluetooth up after a reboot does not accuse itself.
 */
const ADAPTER_WARN_MS = 4_000;

/**
 * Minimum spacing between scan starts. Android allows five per thirty seconds,
 * so six and a half leaves margin for a restart landing early.
 */
const MIN_SCAN_RESTART_MS = 6_500;

type Role = 'central' | 'peripheral';

interface Link {
  peerId: PeerId;
  role: Role;
  /** Platform handle for a link we dialled. Absent for inbound links. */
  device?: Device;
  mtu: number;
  subscriptions: Subscription[];
}

export interface BleTransportOptions {
  /** Sampled by the app; drives the scan duty cycle. */
  deviceState: () => DeviceState;
  onRadioError?: (scope: string, message: string) => void;
  onPlanChanged?: (plan: RadioPlan) => void;
  now?: () => number;
}

export class WhisperBleTransport implements Transport {
  private readonly ble = new BleManager();
  private readonly links = new Map<PeerId, Link>();
  /** Scan results, kept so a planned dial has a handle to dial with. */
  private readonly discovered = new Map<PeerId, Device>();
  private readonly connections: ConnectionManager;
  private readonly duty = new DutyCycleController();

  private chunkHandlers: Array<(peer: PeerId, chunk: Uint8Array) => void> = [];
  private connectHandlers: Array<(peer: PeerId) => void> = [];
  private disconnectHandlers: Array<(peer: PeerId) => void> = [];

  private peerIdBytes: Uint8Array;
  private peerIdSince: number;
  private rotationPending = false;

  private nativeSubscriptions: Array<{ remove: () => void }> = [];
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private planTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private running = false;
  private dialling = new Set<PeerId>();

  constructor(private readonly options: BleTransportOptions) {
    this.peerIdBytes = randomBytes(PEER_ID_BYTES);
    this.peerIdSince = this.now();
    this.connections = new ConnectionManager({
      localPeerId: bytesToHex(this.peerIdBytes),
      maxConnections: MAX_CONNECTIONS,
    });
  }

  /**
   * Rotating, by design. See `PEER_ID_ROTATION_MS`: a stable id in a BLE
   * advertisement is a tracking beacon.
   */
  get localPeerId(): PeerId {
    return bytesToHex(this.peerIdBytes);
  }

  mtu(peer: PeerId): number {
    const link = this.links.get(peer);
    return (link?.mtu ?? DEFAULT_MTU) - ATT_HEADER_BYTES;
  }

  peers(): PeerId[] {
    return [...this.links.keys()];
  }

  async send(peer: PeerId, chunk: Uint8Array): Promise<void> {
    const link = this.links.get(peer);
    if (!link) throw new PeerUnreachableError(peer);

    const data = bytesToBase64(chunk);
    try {
      if (link.role === 'central') {
        // Write-without-response: an ack per fragment would halve throughput at
        // exactly the MTU where a frame already needs nine of them.
        await link.device!.writeCharacteristicWithoutResponseForService(
          SERVICE_UUID,
          INBOX_CHARACTERISTIC_UUID,
          data,
        );
      } else {
        await WhisperBle.notify(peer, data);
      }
    } catch {
      // The link went away mid-send. Tear it down here rather than leaving a
      // dead entry that `peers()` would keep advertising as reachable.
      this.dropLink(peer);
      throw new PeerUnreachableError(peer);
    }
  }

  onChunk(handler: (peer: PeerId, chunk: Uint8Array) => void): () => void {
    this.chunkHandlers.push(handler);
    return () => {
      this.chunkHandlers = this.chunkHandlers.filter((h) => h !== handler);
    };
  }

  onPeerConnected(handler: (peer: PeerId) => void): () => void {
    this.connectHandlers.push(handler);
    return () => {
      this.connectHandlers = this.connectHandlers.filter((h) => h !== handler);
    };
  }

  onPeerDisconnected(handler: (peer: PeerId) => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.running) return;

    // Android 12 made scanning, advertising and connecting runtime permissions.
    // Declaring them in the manifest is not enough: without the grant the
    // scanner returns no results and the advertiser fails, both *silently*, so
    // the app looks like it is running a mesh that can never find a peer. Ask
    // before touching the adapter, and surface a refusal rather than sitting in
    // a state that cannot work.
    if (!(await this.ensurePermissions())) return;

    this.running = true;

    await this.waitForAdapter();
    this.subscribeToPeripheral();

    await WhisperBle.startGattServer({
      serviceUuid: SERVICE_UUID,
      inboxCharacteristicUuid: INBOX_CHARACTERISTIC_UUID,
      outboxCharacteristicUuid: OUTBOX_CHARACTERISTIC_UUID,
    });

    this.applyPlan();
    // One tick drives both the scan duty cycle and the dial policy. They are
    // deliberately on the same clock: dialling during a scan gap wastes the
    // freshest discovery results.
    this.planTimer = setInterval(() => this.applyPlan(), 1_000);
  }

  /**
   * Returns false when the radio must not be started. iOS asks at first use via
   * the Info.plist strings, so there is nothing to request here.
   *
   * POST_NOTIFICATIONS is requested alongside the radio permissions rather than
   * later: the relay notification is the only thing that tells a user their
   * battery is being spent, and a background app using the radio invisibly is
   * exactly what the listing promises never happens.
   */
  private async ensurePermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;

    const api = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const wanted: string[] = [];

    if (api >= 31) {
      wanted.push(
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      );
    }
    if (api >= 33) {
      wanted.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    if (wanted.length === 0) return true;

    let granted: Record<string, string>;
    try {
      granted = await PermissionsAndroid.requestMultiple(
        wanted as Parameters<typeof PermissionsAndroid.requestMultiple>[0],
      );
    } catch (error) {
      this.options.onRadioError?.('permissions', String(error));
      return false;
    }

    // POST_NOTIFICATIONS is not load-bearing for the mesh — refusing it costs
    // the notification, not the radio — so it is deliberately not required here.
    const required =
      api >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          ]
        : [];
    const refused = required.filter((name) => granted[name] !== 'granted');

    if (refused.length > 0) {
      this.options.onRadioError?.(
        'permissions',
        'Bluetooth permission was refused, so this phone cannot find or be found ' +
          'by others. Grant Nearby devices in Settings, then reopen the app.',
      );
      return false;
    }
    return true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.planTimer) clearInterval(this.planTimer);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.planTimer = null;
    this.scanTimer = null;

    this.ble.stopDeviceScan();
    this.scanning = false;

    for (const subscription of this.nativeSubscriptions.splice(0)) subscription.remove();
    for (const peerId of [...this.links.keys()]) this.dropLink(peerId);

    await WhisperBle.stopAdvertising().catch(() => undefined);
    await WhisperBle.stopGattServer().catch(() => undefined);
  }

  destroy(): void {
    void this.stop();
    this.ble.destroy();
  }

  // ------------------------------------------------------------ duty cycle

  /**
   * Recompute the radio plan and apply it. Called every second; almost every
   * call is a no-op, which is the point — restarting the BLE scanner is itself
   * expensive, so the plan only takes effect when it actually changes.
   */
  private applyPlan(): void {
    if (!this.running) return;

    const now = this.now();
    const state = this.options.deviceState();
    const plan = this.duty.update({ ...state, neighbourCount: this.links.size }, now);
    this.options.onPlanChanged?.(plan);

    void this.refreshAdvertisement(plan, now);
    this.driveScan(plan);
    this.dialPlannedPeers(now);
  }

  private async refreshAdvertisement(plan: RadioPlan, now: number): Promise<void> {
    const due = now - this.peerIdSince >= PEER_ID_ROTATION_MS;

    // Rotating while links are up breaks them: a peer that reconnects under a
    // new id looks like a stranger and pays for a whole fresh handshake. Defer
    // to the next quiet moment — the tracking window this widens is bounded by
    // how long a link lasts, which is minutes.
    if (due && this.links.size === 0) {
      this.peerIdBytes = randomBytes(PEER_ID_BYTES);
      this.peerIdSince = now;
      this.rotationPending = false;
    } else if (due) {
      this.rotationPending = true;
    }

    try {
      await WhisperBle.startAdvertising({
        serviceUuid: SERVICE_UUID,
        serviceData: bytesToBase64(encodeAdvertisement(this.peerIdBytes)),
        intervalMs: plan.advertiseIntervalMs,
      });
    } catch (error) {
      this.options.onRadioError?.('advertise', String(error));
    }
  }

  /**
   * Scan for a window, then idle for the rest of the cycle.
   *
   * The cycle is stretched to at least `MIN_SCAN_RESTART_MS`, because Android
   * polices scan *starts* rather than scan time: five in any thirty seconds and
   * `startScan` fails outright. At full power the duty cycle asks for a
   * one-second cycle, which exhausts that budget in five seconds and leaves the
   * phone deaf while still advertising — visible to others, blind to them, and
   * reported only as "Cannot start scanning operation".
   *
   * The duty *ratio* is preserved, so the battery cost the power controller
   * calculated still holds: fewer, longer windows rather than a stream of short
   * ones.
   */
  private driveScan(plan: RadioPlan): void {
    if (this.scanTimer || this.scanning) return;

    const interval = Math.max(plan.scanIntervalMs, MIN_SCAN_RESTART_MS);
    const ratio = plan.scanWindowMs / Math.max(1, plan.scanIntervalMs);
    const windowMs = Math.min(interval, Math.max(plan.scanWindowMs, Math.round(ratio * interval)));

    this.scanning = true;
    this.ble.startDeviceScan([SERVICE_UUID], { allowDuplicates: true }, (error, device) => {
      if (error) {
        this.options.onRadioError?.('scan', error.message);
        return;
      }
      if (device) this.observe(device);
    });

    this.scanTimer = setTimeout(() => {
      // A window covering the whole cycle means continuous scanning; stopping
      // only to restart immediately would spend a start for nothing.
      if (windowMs >= interval) {
        this.scanTimer = null;
        this.scanning = false;
        return;
      }

      this.ble.stopDeviceScan();
      this.scanning = false;
      this.scanTimer = setTimeout(
        () => {
          this.scanTimer = null;
        },
        Math.max(0, interval - windowMs),
      );
    }, windowMs);
  }

  private observe(device: Device): void {
    // Manufacturer data arrives with the two-byte company id still attached;
    // strip it before the payload means anything. A device advertising under
    // someone else's company id is simply not one of ours.
    const raw = device.manufacturerData;
    if (!raw) return;
    const bytes = base64ToBytes(raw);
    if (bytes.length < 2) return;
    if (((bytes[1]! << 8) | bytes[0]!) !== MANUFACTURER_ID) return;

    const peerId = decodeAdvertisement(bytes.subarray(2));
    if (!peerId) return;

    this.discovered.set(peerId, device);
    this.connections.observe({ peerId, rssi: device.rssi ?? -127, seenAt: this.now() });
  }

  private dialPlannedPeers(now: number): void {
    for (const peerId of this.connections.plan(now)) {
      if (this.dialling.has(peerId) || this.links.has(peerId)) continue;
      const device = this.discovered.get(peerId);
      if (!device) continue;
      this.dialling.add(peerId);
      void this.dial(peerId, device);
    }
  }

  // ---------------------------------------------------------- central role

  private async dial(peerId: PeerId, device: Device): Promise<void> {
    try {
      const connected = await device.connect({ timeout: CONNECT_TIMEOUT_MS });

      // Before discovery, not after: on Android the MTU applies to the whole
      // link, and raising it later means every fragment already queued was
      // needlessly cut to 20 bytes.
      const withMtu = await connected.requestMTU(PREFERRED_MTU).catch(() => connected);
      await withMtu.discoverAllServicesAndCharacteristics();

      const link: Link = {
        peerId,
        role: 'central',
        device: withMtu,
        mtu: withMtu.mtu ?? DEFAULT_MTU,
        subscriptions: [],
      };

      link.subscriptions.push(
        withMtu.monitorCharacteristicForService(
          SERVICE_UUID,
          OUTBOX_CHARACTERISTIC_UUID,
          (error: BleError | null, characteristic) => {
            if (error || !characteristic?.value) return;
            this.deliver(peerId, base64ToBytes(characteristic.value));
          },
        ),
      );

      link.subscriptions.push(
        this.ble.onDeviceDisconnected(withMtu.id, () => this.dropLink(peerId)),
      );

      this.addLink(link);
    } catch (error) {
      this.connections.onConnectFailed(peerId, this.now());
      this.options.onRadioError?.('connect', String(error));
    } finally {
      this.dialling.delete(peerId);
    }
  }

  // ------------------------------------------------------- peripheral role

  private subscribeToPeripheral(): void {
    this.nativeSubscriptions.push(
      WhisperBle.addListener('onPeerConnected', ({ peerId, mtu }) => {
        this.addLink({ peerId, role: 'peripheral', mtu, subscriptions: [] });
      }),
      WhisperBle.addListener('onPeerDisconnected', ({ peerId }) => {
        this.dropLink(peerId);
      }),
      WhisperBle.addListener('onChunk', ({ peerId, data }) => {
        this.deliver(peerId, base64ToBytes(data));
      }),
      WhisperBle.addListener('onMtuChanged', ({ peerId, mtu }) => {
        const link = this.links.get(peerId);
        if (link) link.mtu = mtu;
      }),
      WhisperBle.addListener('onRadioError', ({ scope, message }) => {
        this.options.onRadioError?.(scope, message);
      }),
    );
  }

  // ------------------------------------------------------------- plumbing

  private addLink(link: Link): void {
    // Both sides dialling at once still happens: role arbitration is decided on
    // ids that can rotate, and a peer we adopted inbound may also be one we had
    // already planned to dial. Keep the first link and let the second lapse.
    if (this.links.has(link.peerId)) {
      for (const subscription of link.subscriptions) subscription.remove();
      return;
    }
    this.links.set(link.peerId, link);
    this.connections.onConnected(link.peerId, this.now());
    for (const handler of this.connectHandlers) handler(link.peerId);
  }

  private dropLink(peerId: PeerId): void {
    const link = this.links.get(peerId);
    if (!link) return;
    for (const subscription of link.subscriptions) subscription.remove();
    this.links.delete(peerId);
    this.discovered.delete(peerId);
    this.connections.onDisconnected(peerId, this.now());
    for (const handler of this.disconnectHandlers) handler(peerId);

    // A rotation held back while this link was up can now happen.
    if (this.rotationPending && this.links.size === 0) {
      this.peerIdBytes = randomBytes(PEER_ID_BYTES);
      this.peerIdSince = this.now();
      this.rotationPending = false;
    }
  }

  private deliver(peerId: PeerId, chunk: Uint8Array): void {
    for (const handler of this.chunkHandlers) handler(peerId, chunk);
  }

  /** Bluetooth may be off, or the adapter still starting up after a reboot. */
  /**
   * Resolves when the adapter is usable, however long that takes — Bluetooth
   * being off is a condition the user fixes, not an error to give up on.
   *
   * It does report the wait, though. Silently blocking forever on a powered-off
   * radio is indistinguishable from a crash, and "turn Bluetooth on" is the one
   * piece of advice that would have resolved it.
   */
  private waitForAdapter(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const nudge = setTimeout(() => {
        if (!settled) {
          this.options.onRadioError?.(
            'bluetooth',
            'Waiting for Bluetooth. Turn it on to find nearby devices.',
          );
        }
      }, ADAPTER_WARN_MS);

      const subscription = this.ble.onStateChange((state) => {
        if (state === 'PoweredOn') {
          settled = true;
          clearTimeout(nudge);
          subscription.remove();
          resolve();
        }
      }, true);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
