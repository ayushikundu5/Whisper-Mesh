import type { RouteProp } from '@react-navigation/native';
import { useRoute } from '@react-navigation/native';
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
import { RootStackParamList } from '../navigation';
import { conversationIdFor, useMesh } from '../state/MeshProvider';
import { StoredMessage } from '../storage/db';
import { useTheme } from '../ui/ThemeProvider';
import { spacing } from '../ui/theme';

/** Local wall-clock time, to the minute. Dates would be noise in a chat this short. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** One private conversation. Every message here is end-to-end encrypted. */
export function ChatScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Chat'>>();
  const { conversationId, name } = route.params;
  const { contacts, history, subscribe, sendDirect, sessionUp } = useMesh();
  const { colors, styles } = useTheme();

  const contact = contacts.find((c) => conversationIdFor(c) === conversationId);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState('');

  const refresh = useCallback(() => {
    void history(conversationId).then(setMessages);
  }, [conversationId, history]);

  useEffect(() => {
    refresh();
    return subscribe(conversationId, refresh);
  }, [conversationId, refresh, subscribe]);

  const send = async () => {
    const body = draft.trim();
    if (!body || !contact) return;
    setDraft('');
    await sendDirect(contact, body);
  };

  if (!contact) {
    return (
      <SafeAreaView style={[styles.screen, styles.padded]}>
        <Text style={styles.body}>This contact has been removed.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {!sessionUp(contact) ? (
          <View style={[styles.banner, { margin: spacing.md, marginBottom: 0 }]}>
            <Text style={styles.bodyStrong}>Not connected to {name}</Text>
            <Text style={[styles.dim, { marginTop: 2 }]}>
              Messages you write now will be sent as soon as they come into range.
            </Text>
          </View>
        ) : null}

        <FlatList
          data={messages}
          keyExtractor={(message) => message.id}
          contentContainerStyle={{ padding: spacing.md }}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', paddingVertical: spacing.xl }}>
              <Text style={styles.dim}>No messages yet. Say something.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.bubble, item.outbound ? styles.bubbleOut : styles.bubbleIn]}>
              <Text style={item.outbound ? styles.bubbleTextOut : styles.bubbleTextIn}>
                {item.body}
              </Text>
              {/*
                Local receipt time, not the sender's claimed timestamp — the
                same reason the database orders by it. A peer can put anything
                in that field.
              */}
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
          style={[
            styles.padded,
            styles.row,
            { borderTopWidth: 1, borderTopColor: colors.border },
          ]}
        >
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${name}`}
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
