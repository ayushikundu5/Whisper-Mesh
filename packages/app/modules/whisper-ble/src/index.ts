import { NativeModule, requireNativeModule } from 'expo-modules-core';

/**
 * The peripheral half of a BLE mesh.
 *
 * `react-native-ble-plx` covers the central role well and does not implement
 * the peripheral role at all, which is the single reason this module has to
 * exist. Without a GATT *server* a phone can only ever dial out, and a mesh of
 * devices that can all dial and none accept never forms a link.
 *
 * Platform reality, and it is not symmetric:
 *
 *  - **Android** can advertise and run a GATT server in the background, given a
 *    foreground service. This is the platform the mesh actually works on.
 *  - **iOS** can advertise in the background, but only the 128-bit service UUID
 *    in the "overflow" area — no service *data*, which is where the ephemeral
 *    peer id lives. Two backgrounded iPhones cannot discover each other at all;
 *    this is an OS restriction with no workaround, not something to engineer
 *    around. The Swift implementation is honest about what it supports and
 *    reports its limits through `capabilities()` so the UI can say so plainly.
 */

export interface PeripheralCapabilities {
  /** Can this device advertise at all? */
  canAdvertise: boolean;
  /** Can it run a GATT server? */
  canRunGattServer: boolean;
  /** Can it stay discoverable with the screen off / app backgrounded? */
  canAdvertiseInBackground: boolean;
  /** Can it put arbitrary bytes in the advertisement (the peer id)? */
  canAdvertiseServiceData: boolean;
}

export interface GattServerConfig {
  serviceUuid: string;
  /** Peers write fragments here. */
  inboxCharacteristicUuid: string;
  /** We notify fragments out through here. */
  outboxCharacteristicUuid: string;
}

export interface AdvertisePayload {
  serviceUuid: string;
  /** Base64. The bridge cannot carry a Uint8Array cheaply. */
  serviceData: string;
  /** Requested advertising interval. The OS may round it. */
  intervalMs: number;
}

export interface PeerConnectedEvent {
  peerId: string;
  mtu: number;
}

export interface PeerDisconnectedEvent {
  peerId: string;
}

export interface ChunkEvent {
  peerId: string;
  /** Base64-encoded fragment exactly as written by the peer. */
  data: string;
}

export interface MtuEvent {
  peerId: string;
  mtu: number;
}

export interface RadioErrorEvent {
  /** One of: advertise, gatt, permission, adapter. */
  scope: string;
  message: string;
}

export type WhisperBleEvents = {
  onPeerConnected: (event: PeerConnectedEvent) => void;
  onPeerDisconnected: (event: PeerDisconnectedEvent) => void;
  onChunk: (event: ChunkEvent) => void;
  onMtuChanged: (event: MtuEvent) => void;
  onRadioError: (event: RadioErrorEvent) => void;
};

declare class WhisperBleModuleType extends NativeModule<WhisperBleEvents> {
  capabilities(): Promise<PeripheralCapabilities>;

  startAdvertising(payload: AdvertisePayload): Promise<void>;
  stopAdvertising(): Promise<void>;

  startGattServer(config: GattServerConfig): Promise<void>;
  stopGattServer(): Promise<void>;

  /** Push one fragment to a connected central. Rejects if it has gone. */
  notify(peerId: string, data: string): Promise<void>;

  /** Negotiated ATT MTU for a peer, or 23 if none was negotiated. */
  mtuFor(peerId: string): Promise<number>;

  /**
   * Android only. Keeps the radio alive with the app backgrounded; without it
   * the OS stops the GATT server within minutes and the device silently drops
   * out of the mesh. No-op elsewhere.
   */
  startForegroundService(title: string, body: string): Promise<void>;
  stopForegroundService(): Promise<void>;
}

export default requireNativeModule<WhisperBleModuleType>('WhisperBle');
