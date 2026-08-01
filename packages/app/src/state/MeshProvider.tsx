import {
  Contact,
  DeviceState,
  MeshNode,
  Messenger,
  PairingPayload,
  PowerMode,
  RadioPlan,
  TrustStore,
  buildPairingPayload,
  encodePairingUri,
  msgIdToHex,
} from '@whisper/core';
import * as Battery from 'expo-battery';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import WhisperBle from '../../modules/whisper-ble/src';
import { WhisperBleTransport } from '../ble/BleTransport';
import {
  CHANNEL_CONVERSATION,
  StoredMessage,
  loadConversation,
  loadTrustStore,
  persistTrustStore,
  saveMessage,
  wipeEverything,
} from '../storage/db';
import { destroyIdentity, loadOrCreateIdentity, setDisplayName } from '../storage/identity';

/**
 * Everything the UI is allowed to know about.
 *
 * The provider owns the lifecycle — identity, radio, mesh, sessions — and hands
 * the screens a small, boring API. No screen touches a frame, a key, or the
 * transport; if a component needs protocol knowledge to render, that is a sign
 * the boundary has been crossed in the wrong direction.
 */

export interface MeshContextValue {
  ready: boolean;
  displayName: string;
  contacts: Contact[];
  neighbourCount: number;
  radio: RadioPlan | null;
  /** Present when the radio is failing in a way the user needs to see. */
  radioError: string | null;
  /** True where the platform cannot relay in the background. See the iOS note. */
  backgroundLimited: boolean;

  myPairingUri: string;
  pair: (payload: PairingPayload) => Promise<Contact>;
  forget: (contact: Contact) => Promise<void>;
  rename: (name: string) => Promise<void>;

  sessionUp: (contact: Contact) => boolean;
  sendDirect: (contact: Contact, body: string) => Promise<void>;
  sendChannel: (body: string) => Promise<void>;

  history: (conversation: string) => Promise<StoredMessage[]>;
  /** Fires whenever a conversation gains a message, so screens can refresh. */
  subscribe: (conversation: string, handler: () => void) => () => void;

  panic: () => Promise<void>;
}

const MeshContext = createContext<MeshContextValue | null>(null);

export function useMesh(): MeshContextValue {
  const value = useContext(MeshContext);
  if (!value) throw new Error('useMesh must be used inside <MeshProvider>');
  return value;
}

const MAINTENANCE_INTERVAL_MS = 30_000;

export function MeshProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [displayName, setName] = useState('Anonymous');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [neighbourCount, setNeighbourCount] = useState(0);
  const [radio, setRadio] = useState<RadioPlan | null>(null);
  const [radioError, setRadioError] = useState<string | null>(null);
  const [backgroundLimited, setBackgroundLimited] = useState(false);
  const [myPairingUri, setMyPairingUri] = useState('');

  const messengerRef = useRef<Messenger | null>(null);
  const transportRef = useRef<WhisperBleTransport | null>(null);
  const trustRef = useRef<TrustStore | null>(null);
  const listeners = useRef(new Map<string, Set<() => void>>());

  /**
   * Sampled by the duty-cycle controller. Kept in a ref rather than state
   * because it is read on a one-second timer and re-rendering the whole app at
   * 1Hz to track a battery percentage would cost more power than the radio.
   */
  const deviceState = useRef<DeviceState>({
    batteryLevel: 1,
    charging: false,
    screenOn: true,
    neighbourCount: 0,
    msSinceTraffic: Number.MAX_SAFE_INTEGER,
  });
  const lastTrafficAt = useRef(0);

  const notify = useCallback((conversation: string) => {
    for (const handler of listeners.current.get(conversation) ?? []) handler();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let maintenance: ReturnType<typeof setInterval> | null = null;
    const subscriptions: Array<{ remove: () => void }> = [];

    // The catch below is load-bearing, not defensive habit. Without it a throw
    // anywhere in startup became an unhandled rejection that Hermes reports
    // nowhere: `ready` stayed false, the app sat on its spinner, and the log
    // showed a clean launch. A startup that fails must say so.
    void (async () => {
      const identity = await loadOrCreateIdentity();
      const trust = await loadTrustStore();
      if (cancelled) return;

      const transport = new WhisperBleTransport({
        deviceState: () => ({
          ...deviceState.current,
          msSinceTraffic: Date.now() - lastTrafficAt.current,
        }),
        onRadioError: (scope, message) => setRadioError(`${scope}: ${message}`),
        onPlanChanged: setRadio,
      });

      const mesh = new MeshNode(transport, identity.keys);
      const messenger = new Messenger(mesh, identity.keys, trust);

      messenger.onDirectMessage(async ({ contact, plaintext, frame }) => {
        lastTrafficAt.current = Date.now();
        const conversation = hex(contact.identityKey);
        await saveMessage({
          id: msgIdToHex(frame.msgId),
          conversation,
          outbound: false,
          body: new TextDecoder().decode(plaintext),
          sentAt: frame.timestamp,
          receivedAt: Date.now(),
        });
        notify(conversation);
      });

      messenger.onChannelMessage(async (frame) => {
        lastTrafficAt.current = Date.now();
        await saveMessage({
          id: msgIdToHex(frame.msgId),
          conversation: CHANNEL_CONVERSATION,
          outbound: false,
          body: new TextDecoder().decode(frame.payload),
          sentAt: frame.timestamp,
          receivedAt: Date.now(),
        });
        notify(CHANNEL_CONVERSATION);
      });

      messenger.onSessionEstablished(() => setContacts(trust.contacts()));

      transport.onPeerConnected(() => setNeighbourCount(transport.peers().length));
      transport.onPeerDisconnected(() => setNeighbourCount(transport.peers().length));

      messenger.start();

      // The radio must never gate the UI. `waitForAdapter` waits indefinitely
      // and on purpose — Bluetooth may be switched on minutes later, and the
      // mesh should join when it is — but awaiting it here left the app on its
      // loading spinner forever with Bluetooth off, showing nothing and
      // offering nothing to do. Any native call that fails to settle had the
      // same effect. The home screen already knows how to say `No devices in
      // range` and to show a `Radio problem` banner, so bring the app up first
      // and let the radio report in when it can.
      void (async () => {
        try {
          await transport.start();
          const capabilities = await WhisperBle.capabilities();
          if (cancelled) return;
          setBackgroundLimited(!capabilities.canAdvertiseInBackground);
          if (capabilities.canAdvertiseInBackground) {
            await WhisperBle.startForegroundService(
              'Whisper Mesh',
              'Carrying messages for nearby devices',
            );
          }
        } catch (error) {
          if (!cancelled) setRadioError(`radio: ${String(error)}`);
        }
      })();

      // Battery is polled rather than watched continuously: the level moves
      // percent by percent over minutes, and the charging state has its own
      // event, so anything faster is pure overhead.
      subscriptions.push(
        Battery.addBatteryLevelListener(({ batteryLevel }) => {
          deviceState.current.batteryLevel = batteryLevel;
        }),
        Battery.addBatteryStateListener(({ batteryState }) => {
          deviceState.current.charging =
            batteryState === Battery.BatteryState.CHARGING ||
            batteryState === Battery.BatteryState.FULL;
        }),
      );
      deviceState.current.batteryLevel = await Battery.getBatteryLevelAsync();

      const appStateSubscription = AppState.addEventListener(
        'change',
        (status: AppStateStatus) => {
          deviceState.current.screenOn = status === 'active';
        },
      );
      subscriptions.push(appStateSubscription);

      maintenance = setInterval(() => messenger.maintain(), MAINTENANCE_INTERVAL_MS);

      messengerRef.current = messenger;
      transportRef.current = transport;
      trustRef.current = trust;

      setName(identity.name);
      setContacts(trust.contacts());
      setMyPairingUri(encodePairingUri(buildPairingPayload(identity.keys, identity.name)));
      setReady(true);
    })().catch((error: unknown) => {
      if (cancelled) return;
      // Come up anyway. A phone showing "Storage problem" next to an empty
      // contact list is diagnosable; an identical black screen is not.
      setRadioError(`startup: ${String(error)}`);
      setReady(true);
    });

    return () => {
      cancelled = true;
      if (maintenance) clearInterval(maintenance);
      for (const subscription of subscriptions) subscription.remove();
      messengerRef.current?.stop();
      transportRef.current?.destroy();
      void WhisperBle.stopForegroundService();
    };
  }, [notify]);

  const value = useMemo<MeshContextValue>(
    () => ({
      ready,
      displayName,
      contacts,
      neighbourCount,
      radio,
      radioError,
      backgroundLimited,
      myPairingUri,

      pair: async (payload) => {
        const trust = trustRef.current!;
        const contact = trust.pair(payload, Date.now());
        await persistTrustStore(trust);
        setContacts(trust.contacts());
        // Start the handshake straight away: the two phones are next to each
        // other right now, which is the best radio conditions they will ever
        // have for the one exchange that has to succeed.
        await messengerRef.current!.connect(contact).catch(() => undefined);
        return contact;
      },

      forget: async (contact) => {
        const trust = trustRef.current!;
        trust.forget(contact.identityKey);
        await persistTrustStore(trust);
        setContacts(trust.contacts());
      },

      rename: async (name) => {
        await setDisplayName(name);
        setName(name);
      },

      sessionUp: (contact) => messengerRef.current?.hasSession(contact) ?? false,

      sendDirect: async (contact, body) => {
        lastTrafficAt.current = Date.now();
        const conversation = hex(contact.identityKey);
        await messengerRef.current!.sendDirect(contact, new TextEncoder().encode(body));
        await saveMessage({
          id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          conversation,
          outbound: true,
          body,
          sentAt: Date.now(),
          receivedAt: Date.now(),
        });
        notify(conversation);
      },

      sendChannel: async (body) => {
        lastTrafficAt.current = Date.now();
        const frame = await messengerRef.current!.sendChannel(new TextEncoder().encode(body));
        await saveMessage({
          id: msgIdToHex(frame.msgId),
          conversation: CHANNEL_CONVERSATION,
          outbound: true,
          body,
          sentAt: frame.timestamp,
          receivedAt: Date.now(),
        });
        notify(CHANNEL_CONVERSATION);
      },

      history: (conversation) => loadConversation(conversation),

      subscribe: (conversation, handler) => {
        const set = listeners.current.get(conversation) ?? new Set();
        set.add(handler);
        listeners.current.set(conversation, set);
        return () => set.delete(handler);
      },

      panic: async () => {
        await wipeEverything();
        await destroyIdentity();
        setContacts([]);
      },
    }),
    [
      ready,
      displayName,
      contacts,
      neighbourCount,
      radio,
      radioError,
      backgroundLimited,
      myPairingUri,
      notify,
    ],
  );

  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>;
}

export const POWER_MODE_LABEL: Record<PowerMode, string> = {
  [PowerMode.Critical]: 'Barely scanning — battery critical',
  [PowerMode.Saver]: 'Power saver',
  [PowerMode.Balanced]: 'Balanced',
  [PowerMode.Active]: 'Active',
  [PowerMode.Charging]: 'Charging — relaying at full rate',
};

/**
 * The key a conversation is stored under. The identity key, not the
 * fingerprint: the fingerprint is a truncated digest meant for humans to
 * compare, and using a truncation as a database key invites the one collision
 * that files two people's messages into one thread.
 */
export function conversationIdFor(contact: Contact): string {
  return hex(contact.identityKey);
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
