import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { ActivityIndicator, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootStackParamList } from './src/navigation';
import { ChannelScreen } from './src/screens/ChannelScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { ChatsScreen } from './src/screens/ChatsScreen';
import { PairScreen } from './src/screens/PairScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { MeshProvider, useMesh } from './src/state/MeshProvider';
import { ThemeProvider, useTheme } from './src/ui/ThemeProvider';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <MeshProvider>
          <Root />
        </MeshProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { ready } = useMesh();
  const { colors, styles, scheme } = useTheme();

  // Navigation keeps its own theme, so the header and the card background have
  // to be handed the same palette — otherwise switching to light leaves a dark
  // header sitting above a light screen.
  const navTheme = {
    ...(scheme === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(scheme === 'dark' ? DarkTheme : DefaultTheme).colors,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      primary: colors.accent,
    },
  };

  return (
    <>
      <StatusBar
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
      />
      {/*
        The identity has to be loaded from secure storage before any screen can
        do anything useful, and that is genuinely async. The radio is not waited
        on — see `MeshProvider`; a phone with Bluetooth off still gets a usable
        app and a banner explaining itself.
      */}
      {!ready ? (
        <View
          style={[
            styles.screen,
            { alignItems: 'center', justifyContent: 'center', gap: 16 },
          ]}
        >
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.dim}>Unlocking your identity…</Text>
        </View>
      ) : (
        <NavigationContainer theme={navTheme}>
          <Stack.Navigator
            screenOptions={{
              headerTintColor: colors.text,
              headerStyle: { backgroundColor: colors.background },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="Chats" component={ChatsScreen} options={{ headerShown: false }} />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={({ route }) => ({ title: route.params.name })}
            />
            <Stack.Screen name="Channel" component={ChannelScreen} options={{ title: 'Nearby' }} />
            <Stack.Screen name="Pair" component={PairScreen} options={{ title: 'Add a contact' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      )}
    </>
  );
}
