import { StyleSheet } from 'react-native';

/**
 * Two palettes and the styles built from them.
 *
 * Dark is still the default, and not for fashion: this app is for a phone at
 * 12% battery in a field at night. Dark pixels cost less on OLED, and a screen
 * that does not blind you is a usability feature when the reason you are
 * holding it is that something has gone wrong.
 *
 * Light exists because the other half of the time the phone is at a festival in
 * daylight, where a dark screen is unreadable at arm's length. Neither is the
 * "real" one — see `ThemeProvider`, which follows the system unless told
 * otherwise.
 */

export interface Palette {
  background: string;
  /** Cards and raised surfaces. */
  surface: string;
  /** Inputs and secondary buttons — one step further from the background. */
  surfaceAlt: string;
  border: string;
  text: string;
  textDim: string;
  accent: string;
  /** Text drawn on top of `accent`. Flips between palettes; do not hardcode. */
  onAccent: string;
  /** A session is up, a peer is in range. Never decorative. */
  success: string;
  /** Reserved for genuine trouble. Never for decoration. */
  warn: string;
  danger: string;
  /** Outbound message bubble. */
  outbound: string;
  onOutbound: string;
  /** Bubble for messages from other people. */
  inbound: string;
  shadow: string;
}

export const darkPalette: Palette = {
  background: '#0B0F14',
  surface: '#141A22',
  surfaceAlt: '#1D242D',
  border: '#28323D',
  text: '#E8EDF2',
  textDim: '#8B98A5',
  accent: '#4DB6AC',
  onAccent: '#06231F',
  success: '#4CAF87',
  warn: '#E5A03C',
  danger: '#E05252',
  outbound: '#1F3D3A',
  onOutbound: '#DFF3EF',
  inbound: '#1B222B',
  shadow: '#000000',
};

/**
 * Not the dark palette inverted. Teal at `#4DB6AC` on white fails contrast for
 * body text, so light gets a deeper accent; and a light surface lifts off the
 * background with a shadow where dark uses a border.
 */
export const lightPalette: Palette = {
  background: '#F5F7F9',
  surface: '#FFFFFF',
  surfaceAlt: '#ECF0F4',
  border: '#DCE3EA',
  text: '#14191F',
  textDim: '#5E6B78',
  accent: '#0F766E',
  onAccent: '#FFFFFF',
  success: '#0E7A54',
  warn: '#B4690E',
  danger: '#C0392B',
  outbound: '#0F766E',
  onOutbound: '#FFFFFF',
  inbound: '#FFFFFF',
  shadow: '#8A9AAB',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export type AppStyles = ReturnType<typeof makeStyles>;

export function makeStyles(c: Palette) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.background,
    },
    padded: {
      padding: spacing.md,
    },

    // ------------------------------------------------------------ type scale
    display: {
      color: c.text,
      fontSize: 28,
      fontWeight: '700',
      letterSpacing: -0.5,
    },
    heading: {
      color: c.text,
      fontSize: 20,
      fontWeight: '600',
      marginBottom: spacing.sm,
    },
    body: {
      color: c.text,
      fontSize: 15,
      lineHeight: 21,
    },
    bodyStrong: {
      color: c.text,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 22,
    },
    dim: {
      color: c.textDim,
      fontSize: 13,
      lineHeight: 19,
    },
    /** Section headers above a group of cards. */
    label: {
      color: c.textDim,
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    mono: {
      color: c.textDim,
      fontFamily: 'monospace',
      fontSize: 13,
      letterSpacing: 1,
    },
    /** The six confirmation words. The most important text in the app. */
    words: {
      color: c.text,
      fontSize: 19,
      fontWeight: '700',
      lineHeight: 28,
      letterSpacing: 0.3,
      textAlign: 'center',
    },

    // --------------------------------------------------------------- surfaces
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      // Dark uses the border to separate; light needs the lift, because white
      // on near-white reads as one flat sheet without it.
      shadowColor: c.shadow,
      shadowOpacity: 0.1,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 2 },
      elevation: 1,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    between: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },

    /** Status dot beside the neighbour count. */
    dot: {
      width: 10,
      height: 10,
      borderRadius: radius.pill,
    },
    /** Small rounded tag: "Connected", counts, mode names. */
    pill: {
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
      backgroundColor: c.surfaceAlt,
    },
    pillText: {
      color: c.textDim,
      fontSize: 12,
      fontWeight: '600',
    },

    // ---------------------------------------------------------------- inputs
    input: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      color: c.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      fontSize: 15,
      flex: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    button: {
      backgroundColor: c.accent,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonText: {
      color: c.onAccent,
      fontWeight: '700',
      fontSize: 15,
    },
    buttonSecondary: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 4,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    buttonSecondaryText: {
      color: c.text,
      fontWeight: '600',
      fontSize: 15,
    },
    buttonDanger: {
      backgroundColor: 'transparent',
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 4,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.danger,
    },
    buttonDangerText: {
      color: c.danger,
      fontWeight: '700',
      fontSize: 15,
    },

    // --------------------------------------------------------------- bubbles
    bubble: {
      maxWidth: '82%',
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      marginBottom: spacing.sm,
    },
    bubbleIn: {
      backgroundColor: c.inbound,
      alignSelf: 'flex-start',
      borderBottomLeftRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    bubbleOut: {
      backgroundColor: c.outbound,
      alignSelf: 'flex-end',
      borderBottomRightRadius: radius.sm,
    },
    bubbleTextIn: {
      color: c.text,
      fontSize: 15,
      lineHeight: 21,
    },
    bubbleTextOut: {
      color: c.onOutbound,
      fontSize: 15,
      lineHeight: 21,
    },
    bubbleMeta: {
      fontSize: 11,
      marginTop: 3,
    },

    // --------------------------------------------------------------- banners
    banner: {
      backgroundColor: c.surfaceAlt,
      borderLeftWidth: 3,
      borderLeftColor: c.warn,
      borderRadius: radius.md,
      padding: spacing.md,
    },

    /** Segmented control, used for the light/dark/system choice. */
    segment: {
      flexDirection: 'row',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: 3,
      gap: 3,
    },
    segmentItem: {
      flex: 1,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm + 1,
      alignItems: 'center',
    },
    segmentItemOn: {
      backgroundColor: c.surface,
      shadowColor: c.shadow,
      shadowOpacity: 0.12,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
    segmentText: {
      color: c.textDim,
      fontSize: 14,
      fontWeight: '600',
    },
    segmentTextOn: {
      color: c.text,
    },
  });
}
