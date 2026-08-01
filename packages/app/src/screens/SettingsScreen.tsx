import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { POWER_MODE_LABEL, useMesh } from '../state/MeshProvider';
import { ThemeMode, useTheme } from '../ui/ThemeProvider';
import { spacing } from '../ui/theme';

const THEME_CHOICES: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

export function SettingsScreen() {
  const { displayName, rename, contacts, forget, radio, neighbourCount, panic } = useMesh();
  const { colors, styles, mode, setMode } = useTheme();
  const [name, setName] = useState(displayName);
  const [saved, setSaved] = useState(false);

  const save = () => {
    void rename(name.trim() || 'Anonymous');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <ScrollView contentContainerStyle={[styles.padded, { gap: spacing.lg }]}>
        <View style={{ gap: spacing.sm }}>
          <Text style={styles.label}>Appearance</Text>
          <View style={styles.card}>
            <View style={styles.segment}>
              {THEME_CHOICES.map((choice) => {
                const on = mode === choice.mode;
                return (
                  <Pressable
                    key={choice.mode}
                    onPress={() => setMode(choice.mode)}
                    style={[styles.segmentItem, on ? styles.segmentItemOn : null]}
                  >
                    <Text style={[styles.segmentText, on ? styles.segmentTextOn : null]}>
                      {choice.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.dim, { marginTop: spacing.sm }]}>
              Dark costs less battery on an OLED screen and keeps your night vision. Light is
              readable in direct sun. System follows your phone.
            </Text>
          </View>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text style={styles.label}>Your name</Text>
          <View style={styles.card}>
            <Text style={styles.dim}>
              Shown to people you pair with, and fixed at the moment they scan your code — renaming
              later will not change how you appear to contacts you already have. It is not
              authenticated either; the six confirmation words are what actually identify you.
            </Text>
            <View style={[styles.row, { marginTop: spacing.md }]}>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                maxLength={32}
                placeholder="Your name"
                placeholderTextColor={colors.textDim}
              />
              <Pressable style={styles.button} onPress={save}>
                <Text style={styles.buttonText}>{saved ? 'Saved' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text style={styles.label}>Radio</Text>
          <View style={styles.card}>
            <View style={styles.between}>
              <Text style={styles.bodyStrong}>
                {radio ? POWER_MODE_LABEL[radio.mode] : 'Starting…'}
              </Text>
              <View style={styles.pill}>
                <Text style={styles.pillText}>
                  {neighbourCount} in range
                </Text>
              </View>
            </View>
            {radio ? (
              <Text style={[styles.dim, { marginTop: 4 }]}>
                Listening {Math.round(radio.dutyRatio * 100)}% of the time
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text style={styles.label}>Contacts</Text>
          {contacts.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.dim}>Nobody paired yet.</Text>
            </View>
          ) : (
            contacts.map((contact) => (
              <View key={contact.fingerprint} style={styles.card}>
                <View style={styles.between}>
                  <View style={{ flexShrink: 1, gap: 3 }}>
                    <Text style={styles.bodyStrong}>{contact.name}</Text>
                    <Text style={styles.mono} numberOfLines={1}>
                      {contact.fingerprint}
                    </Text>
                  </View>
                  <Pressable
                    hitSlop={10}
                    onPress={() =>
                      Alert.alert(
                        `Remove ${contact.name}?`,
                        'You will need to pair in person again to message them.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => void forget(contact),
                          },
                        ],
                      )
                    }
                  >
                    <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 14 }}>
                      Remove
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </View>

        {/*
          Stated here rather than buried in a store listing. Someone deciding
          whether to rely on this app needs the limits in the app itself.
        */}
        <View style={{ gap: spacing.sm }}>
          <Text style={styles.label}>What this app does not promise</Text>
          <View style={styles.card}>
            <Text style={styles.dim}>
              Private messages are end-to-end encrypted and nobody can post as you. But this
              project has had no external security review, and it does not hide the fact that you
              are using it, or who is nearby. Do not rely on it where being seen using it would put
              you at risk.
            </Text>
          </View>
        </View>

        <Pressable
          style={styles.buttonDanger}
          onPress={() =>
            Alert.alert(
              'Erase everything?',
              'Deletes your identity, every contact, and every message on this device. This cannot be undone, and everyone will have to pair with you again.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Erase', style: 'destructive', onPress: () => void panic() },
              ],
            )
          }
        >
          <Text style={styles.buttonDangerText}>Erase everything</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
