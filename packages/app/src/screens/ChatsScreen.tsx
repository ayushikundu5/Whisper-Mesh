import { Contact } from '@whisper/core';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { POWER_MODE_LABEL, conversationIdFor, useMesh } from '../state/MeshProvider';
import { RootStackParamList } from '../navigation';
import { useTheme } from '../ui/ThemeProvider';
import { AppStyles, Palette, spacing } from '../ui/theme';

/**
 * The home screen, and the honest one.
 *
 * It leads with the state of the mesh rather than a list of chats, because in
 * this app the answer to "why has my message not arrived" is nearly always
 * "there is nobody in range", and a messenger that hides that turns a physics
 * problem into a trust problem.
 */
export function ChatsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { contacts, neighbourCount, radio, radioError, backgroundLimited, sessionUp, displayName } =
    useMesh();
  const { colors, styles } = useTheme();

  const connected = neighbourCount > 0;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={[styles.padded, { gap: spacing.md, paddingBottom: spacing.sm }]}>
        <View style={styles.between}>
          <View>
            <Text style={styles.display}>Whisper Mesh</Text>
            <Text style={styles.dim}>You are {displayName}</Text>
          </View>
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            hitSlop={12}
            style={[styles.pill, { paddingVertical: spacing.sm }]}
          >
            <Text style={styles.pillText}>Settings</Text>
          </Pressable>
        </View>

        {/*
          The status card is the first thing on the screen because it answers
          the only question that matters before a message can go anywhere. The
          dot carries the same information as the text for someone scanning the
          screen rather than reading it.
        */}
        <View style={styles.card}>
          <View style={styles.between}>
            <View style={[styles.row, { flexShrink: 1 }]}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: connected ? colors.success : colors.textDim },
                ]}
              />
              <Text style={styles.bodyStrong}>
                {neighbourCount === 0
                  ? 'No devices in range'
                  : `${neighbourCount} device${neighbourCount === 1 ? '' : 's'} in range`}
              </Text>
            </View>
            <View style={styles.pill}>
              <Text style={styles.pillText}>{radio ? POWER_MODE_LABEL[radio.mode] : 'Starting'}</Text>
            </View>
          </View>
          {!connected ? (
            <Text style={[styles.dim, { marginTop: spacing.sm }]}>
              Keep this app open and stay within about ten metres of each other.
            </Text>
          ) : null}
        </View>

        {radioError ? (
          <View style={styles.banner}>
            <Text style={styles.bodyStrong}>Radio problem</Text>
            <Text style={[styles.dim, { marginTop: 2 }]}>{radioError}</Text>
          </View>
        ) : null}

        {backgroundLimited ? (
          <View style={styles.banner}>
            <Text style={styles.bodyStrong}>Keep this app open</Text>
            <Text style={[styles.dim, { marginTop: 2 }]}>
              This device cannot stay discoverable in the background, so it will drop out of the
              mesh when you switch away.
            </Text>
          </View>
        ) : null}
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(contact) => contact.fingerprint}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}
        ListHeaderComponent={
          <>
            <Text style={[styles.label, { marginBottom: spacing.sm }]}>Conversations</Text>
            <Row
              colors={colors}
              styles={styles}
              title="Everyone nearby"
              subtitle="Public channel — anyone in range can read this"
              onPress={() => navigation.navigate('Channel')}
            />
          </>
        }
        ListEmptyComponent={
          <View style={[styles.card, { marginTop: spacing.sm }]}>
            <Text style={styles.bodyStrong}>No contacts yet</Text>
            <Text style={[styles.dim, { marginTop: 4 }]}>
              Private messages need a one-time pairing in person — scan each other&apos;s codes and
              you are connected for good.
            </Text>
          </View>
        }
        renderItem={({ item }: { item: Contact }) => {
          const up = sessionUp(item);
          return (
            <Row
              colors={colors}
              styles={styles}
              title={item.name}
              subtitle={up ? 'Connected' : item.fingerprint}
              accent={up}
              mono={!up}
              onPress={() =>
                navigation.navigate('Chat', {
                  conversationId: conversationIdFor(item),
                  name: item.name,
                })
              }
            />
          );
        }}
      />

      <View style={[styles.padded, styles.row]}>
        <Pressable style={[styles.button, { flex: 1 }]} onPress={() => navigation.navigate('Pair')}>
          <Text style={styles.buttonText}>Add a contact</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function Row({
  colors,
  styles,
  title,
  subtitle,
  onPress,
  accent,
  mono,
}: {
  colors: Palette;
  styles: AppStyles;
  title: string;
  subtitle: string;
  onPress: () => void;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { marginBottom: spacing.sm, opacity: pressed ? 0.65 : 1 },
      ]}
    >
      <View style={styles.between}>
        <View style={{ flexShrink: 1, gap: 3 }}>
          <Text style={styles.bodyStrong}>{title}</Text>
          <Text
            style={[
              mono ? styles.mono : styles.dim,
              accent ? { color: colors.success, fontWeight: '600' } : null,
            ]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        </View>
        <Text style={[styles.dim, { fontSize: 20 }]}>›</Text>
      </View>
    </Pressable>
  );
}
