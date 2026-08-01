import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMesh } from '../state/MeshProvider';
import { CHANNEL_CONVERSATION, StoredMessage } from '../storage/db';
import { useTheme } from '../ui/ThemeProvider';
import { spacing } from '../ui/theme';

/** Local wall-clock time, to the minute. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * The public channel: anyone in range can read it.
 *
 * Messages here are signed but not encrypted, and the banner says so in those
 * words. A user who does not understand which of their two message types is
 * readable by strangers has been failed by the interface, not by the crypto.
 */
export function ChannelScreen() {
  const { history, subscribe, sendChannel, neighbourCount } = useMesh();
  const { colors, styles } = useTheme();
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState('');

  const refresh = useCallback(() => {
    void history(CHANNEL_CONVERSATION).then(setMessages);
  }, [history]);

  useEffect(() => {
    refresh();
    return subscribe(CHANNEL_CONVERSATION, refresh);
  }, [refresh, subscribe]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    await sendChannel(body);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.banner, { margin: spacing.md, marginBottom: 0 }]}>
          <Text style={styles.bodyStrong}>Everyone nearby can read this</Text>
          <Text style={[styles.dim, { marginTop: 2 }]}>
            Public channel messages are signed, so nobody can post as you — but they are not
            encrypted. For anything private, pair with someone first.
          </Text>
        </View>

        <FlatList
          data={messages}
          keyExtractor={(message) => message.id}
          contentContainerStyle={{ padding: spacing.md }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: spacing.xl }}>
              <Text style={[styles.dim, { textAlign: 'center' }]}>
                {neighbourCount === 0
                  ? 'Nothing here yet, and no devices in range to hear you.'
                  : 'Nothing here yet. Say something.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.outbound ? styles.bubbleOut : styles.bubbleIn]}>
              <Text style={item.outbound ? styles.bubbleTextOut : styles.bubbleTextIn}>
                {item.body}
              </Text>
              <Text
                style={[
                  styles.bubbleMeta,
                  {
                    color: item.outbound ? colors.onOutbound : colors.textDim,
                    opacity: item.outbound ? 0.75 : 1,
                    textAlign: item.outbound ? 'right' : 'left',
                  },
                ]}
              >
                {clockTime(item.receivedAt)}
              </Text>
            </View>
          )}
        />

        <View
          style={[styles.padded, styles.row, { borderTopWidth: 1, borderTopColor: colors.border }]}
        >
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message everyone nearby"
            placeholderTextColor={colors.textDim}
            multiline
          />
          <Pressable
            style={[styles.button, { opacity: draft.trim() ? 1 : 0.45 }]}
            disabled={!draft.trim()}
            onPress={send}
          >
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
