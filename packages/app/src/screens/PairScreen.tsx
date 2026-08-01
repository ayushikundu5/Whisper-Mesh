import {
  PairingError,
  decodePairingUri,
  pairingWords,
  parsePairingPayload,
} from '@whisper/core';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMesh } from '../state/MeshProvider';
import { useTheme } from '../ui/ThemeProvider';
import { spacing } from '../ui/theme';

/**
 * Pairing. The one screen where the security of the whole app is decided.
 *
 * Three deliberate choices, each of which a friendlier design would get wrong:
 *
 *  1. **No remote pairing.** No links, no codes to read out over a phone call,
 *     no "add by username". Keys enter the trust store by camera or not at all.
 *     Every convenient alternative reintroduces the channel an attacker needs.
 *
 *  2. **The confirmation words are shown, not hidden behind "advanced".** They
 *     are six words derived from both keys. If a MITM had swapped either one,
 *     the two phones would show different words. This is the check that makes
 *     the whole thing work, so it gets the largest text on the screen.
 *
 *  3. **A failed scan is an error, not a retry.** A payload whose signature does
 *     not verify is either a corrupt scan or an attack, and the difference is
 *     not something to paper over with a spinner.
 */
/** Fixed, because a SurfaceView will not lay itself out from a flex hint. */
const PREVIEW_HEIGHT = 340;

export function PairScreen() {
  const { myPairingUri, displayName, pair, rename } = useMesh();
  const { colors, styles } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(displayName);

  /**
   * This device's own six words.
   *
   * The digest covers one payload's two keys, so a phone can derive the words
   * for its own code without ever seeing the other party's. Showing them beside
   * the QR is what makes the check possible at all: the scanner is told six
   * words and, until now, had nothing to compare them against — the phone being
   * scanned displayed none, so "both phones must show the same six words" asked
   * for something the screen never provided.
   */
  const myWords = useMemo(() => {
    if (!myPairingUri) return null;
    try {
      return pairingWords(parsePairingPayload(decodePairingUri(myPairingUri)));
    } catch {
      return null;
    }
  }, [myPairingUri]);

  const onScanned = async ({ data }: { data: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      const payload = parsePairingPayload(decodePairingUri(data));
      const words = pairingWords(payload);
      setScanning(false);

      Alert.alert(
        `Pair with ${payload.name || 'this device'}?`,
        `Both phones must show the same six words:\n\n${words.join('  ')}\n\n` +
          'If they differ, someone is between you. Do not continue.',
        [
          { text: 'They differ', style: 'cancel' },
          {
            text: 'They match',
            onPress: () => {
              void pair(payload).catch((error: unknown) =>
                Alert.alert('Could not pair', describe(error)),
              );
            },
          },
        ],
      );
    } catch (error) {
      setScanning(false);
      Alert.alert('That code did not verify', describe(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <ScrollView contentContainerStyle={[styles.padded, { gap: spacing.md }]}>
        {scanning ? (
          <View style={{ height: PREVIEW_HEIGHT }}>
            {/*
              No rounded corners, and no `flex: 1` on the preview. The camera
              renders into a SurfaceView, which Android composites outside the
              normal view hierarchy: clipping it with `overflow: 'hidden'`
              leaves the camera running and the preview blank — active light on,
              nothing drawn. A flexed child of an auto-height parent inside a
              ScrollView can also measure to zero. An explicit height is the one
              thing a SurfaceView reliably honours.
            */}
            <CameraView
              style={{ width: '100%', height: PREVIEW_HEIGHT }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
            />
          </View>
        ) : (
          <View style={[styles.card, { alignItems: 'center', gap: spacing.md }]}>
            <Text style={styles.label}>Your code</Text>
            {myPairingUri ? (
              // The QR keeps a white quiet zone in both themes. A dark-on-dark
              // code is not a style choice, it is an unscannable one.
              <View style={{ backgroundColor: '#FFFFFF', padding: spacing.md, borderRadius: 12 }}>
                <QRCode value={myPairingUri} size={220} />
              </View>
            ) : null}

            {myWords ? (
              <View
                style={{
                  alignItems: 'center',
                  gap: spacing.xs,
                  alignSelf: 'stretch',
                  backgroundColor: colors.surfaceAlt,
                  borderRadius: 12,
                  padding: spacing.md,
                }}
              >
                <Text style={styles.label}>Your six words</Text>
                <Text style={styles.words}>{myWords.join('  ')}</Text>
                <Text style={[styles.dim, { textAlign: 'center' }]}>
                  The phone scanning this code must show these exact words.
                </Text>
              </View>
            ) : null}

            {/*
              The name travels inside the signed payload, so it is fixed at the
              moment the code is scanned. Renaming afterwards cannot reach a
              contact already stored on someone else's phone — which is how a
              pair of devices ends up listing each other as "Anonymous" for
              good. Offer the edit here, before the code is shared.
            */}
            <View style={[styles.row, { alignSelf: 'stretch' }]}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                maxLength={32}
                placeholder="Your name"
                placeholderTextColor={colors.textDim}
              />
              <Pressable
                style={styles.button}
                onPress={() => void rename(name.trim() || 'Anonymous')}
              >
                <Text style={styles.buttonText}>Save</Text>
              </Pressable>
            </View>
            <Text style={[styles.dim, { textAlign: 'center' }]}>
              Set this before they scan you — it is what they will see you as.
            </Text>
          </View>
        )}

        <Pressable
          style={scanning ? styles.buttonSecondary : styles.button}
          onPress={async () => {
            if (!permission?.granted) {
              const result = await requestPermission();
              if (!result.granted) {
                Alert.alert(
                  'Camera needed',
                  'Pairing happens by scanning a code in person. There is no other way to add a contact.',
                );
                return;
              }
            }
            setScanning((value) => !value);
          }}
        >
          <Text style={scanning ? styles.buttonSecondaryText : styles.buttonText}>
            {scanning ? 'Show my code instead' : 'Scan their code'}
          </Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.bodyStrong}>Why in person?</Text>
          <Text style={[styles.dim, { marginTop: 4 }]}>
            Anything sent over the air could have been sent by somebody else. Scanning a code you
            can physically see is the one exchange nobody can stand in the middle of — so it is the
            only one this app trusts. Do it once and you are connected for good.
          </Text>
        </View>
      </ScrollView>

      <View
        style={{
          padding: spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.surface,
        }}
      >
        <Text style={[styles.dim, { textAlign: 'center' }]}>
          Both phones must show the same six words before you tap “They match”.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function describe(error: unknown): string {
  if (error instanceof PairingError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unrecognised code.';
}
