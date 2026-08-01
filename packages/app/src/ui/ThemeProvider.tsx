import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { loadPreference, savePreference } from '../storage/prefs';
import { AppStyles, Palette, darkPalette, lightPalette, makeStyles } from './theme';

/**
 * Theme selection.
 *
 * `system` is the default and the honest one — a user who has set their phone
 * to dark at night has already answered this question, and asking again is a
 * setting for its own sake. The explicit choices exist because this app is used
 * in conditions the OS cannot see: bright sun at a festival, or a dark field
 * where a white screen ruins night vision and announces where you are.
 *
 * The preference is stored in the plain preferences table, not the keystore. It
 * is not a secret, and `panic()` deliberately does not clear it — wiping your
 * contacts should not also change the colour of the screen, which would be a
 * visible signal that something just happened.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  colors: Palette;
  styles: AppStyles;
  mode: ThemeMode;
  /** What `mode` actually resolved to once the system was consulted. */
  scheme: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

const PREFERENCE_KEY = 'ui.theme.mode';

function isMode(value: string | null): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadPreference(PREFERENCE_KEY).catch(() => null);
      if (!cancelled && isMode(stored)) setModeState(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    // `useColorScheme` can report null before the OS has answered, and the type
    // admits 'unspecified' besides. Falling back to dark rather than light
    // avoids a white flash on a phone that is about to report dark anyway.
    const fromSystem: 'light' | 'dark' = system === 'light' ? 'light' : 'dark';
    const scheme: 'light' | 'dark' = mode === 'system' ? fromSystem : mode;
    const colors = scheme === 'dark' ? darkPalette : lightPalette;

    return {
      colors,
      styles: makeStyles(colors),
      mode,
      scheme,
      setMode: (next: ThemeMode) => {
        setModeState(next);
        void savePreference(PREFERENCE_KEY, next).catch(() => undefined);
      },
    };
  }, [mode, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
