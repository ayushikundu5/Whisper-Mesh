/**
 * How hard to run the radio.
 *
 * Continuous BLE scanning is the single largest power cost in this app, well
 * ahead of crypto or CPU — a phone scanning flat out drains in hours, and an
 * offline messenger that dies before the outage ends is worse than useless.
 * Advertising is roughly an order of magnitude cheaper than scanning, so the
 * policy below cuts scanning hard and keeps advertising alive: a node that can
 * still be *found* remains part of the mesh even when it has mostly stopped
 * looking.
 *
 * Pure functions on an observed device state, so battery policy is testable
 * without a battery. The app samples the state and applies the plan; every
 * decision lives here.
 */

export enum PowerMode {
  /** Nearly flat. Stay findable, barely look. */
  Critical = 'critical',
  /** Low battery, or the OS asked us to back off. */
  Saver = 'saver',
  /** Backgrounded and idle. The steady state for most of a day. */
  Balanced = 'balanced',
  /** Screen on, or traffic in the last few minutes. */
  Active = 'active',
  /** Plugged in. Be the relay everyone else is leaning on. */
  Charging = 'charging',
}

export interface DeviceState {
  /** 0..1. */
  batteryLevel: number;
  charging: boolean;
  /** Proxy for "the user is looking at the app". */
  screenOn: boolean;
  /** Neighbours currently connected. */
  neighbourCount: number;
  /** Since the last frame sent or received. */
  msSinceTraffic: number;
}

export interface RadioPlan {
  mode: PowerMode;
  scanWindowMs: number;
  scanIntervalMs: number;
  advertiseIntervalMs: number;
  /** `scanWindowMs / scanIntervalMs`. The number that predicts battery life. */
  dutyRatio: number;
}

/**
 * Below this a scan window is too short to reliably catch an advertisement:
 * advertisers hop three channels, so a window has to span enough of the
 * advertising interval to land on the one being listened to.
 */
export const MIN_SCAN_WINDOW_MS = 100;

/** BLE advertising interval bounds from the spec. */
export const MIN_ADVERTISE_INTERVAL_MS = 20;
export const MAX_ADVERTISE_INTERVAL_MS = 10_240;

export const CRITICAL_BATTERY = 0.05;
export const SAVER_BATTERY = 0.15;

/** Traffic this recent counts as an active conversation. */
export const ACTIVE_TRAFFIC_MS = 3 * 60_000;

interface ModeProfile {
  /** Fraction of wall-clock time spent scanning, before adjustment. */
  baseDuty: number;
  /** Hard ceiling, so no adjustment can push a mode past its power budget. */
  maxDuty: number;
  minDuty: number;
  scanIntervalMs: number;
  advertiseIntervalMs: number;
  /** Whether loneliness may push this mode to scan harder. */
  boostWhenAlone: boolean;
}

const PROFILES: Record<PowerMode, ModeProfile> = {
  [PowerMode.Critical]: {
    baseDuty: 0.02,
    maxDuty: 0.03,
    minDuty: 0.01,
    scanIntervalMs: 30_000,
    advertiseIntervalMs: 5_000,
    // Deliberately not boosted. At 4% battery, hunting for company is exactly
    // the wrong instinct — staying advertisable for another few hours is worth
    // more to the mesh than finding one more neighbour now.
    boostWhenAlone: false,
  },
  [PowerMode.Saver]: {
    baseDuty: 0.05,
    maxDuty: 0.08,
    minDuty: 0.02,
    scanIntervalMs: 10_000,
    advertiseIntervalMs: 2_000,
    boostWhenAlone: false,
  },
  [PowerMode.Balanced]: {
    baseDuty: 0.15,
    maxDuty: 0.3,
    minDuty: 0.04,
    scanIntervalMs: 5_000,
    advertiseIntervalMs: 1_000,
    boostWhenAlone: true,
  },
  [PowerMode.Active]: {
    baseDuty: 0.4,
    maxDuty: 0.6,
    minDuty: 0.1,
    scanIntervalMs: 2_000,
    advertiseIntervalMs: 500,
    boostWhenAlone: true,
  },
  [PowerMode.Charging]: {
    baseDuty: 0.6,
    maxDuty: 0.8,
    minDuty: 0.2,
    scanIntervalMs: 1_000,
    advertiseIntervalMs: 250,
    boostWhenAlone: true,
  },
};

/** Extra scanning when we have no neighbours at all and can afford to look. */
export const LONELY_BOOST = 1.5;

export function selectMode(state: DeviceState): PowerMode {
  if (state.charging) return PowerMode.Charging;
  if (state.batteryLevel <= CRITICAL_BATTERY) return PowerMode.Critical;
  if (state.batteryLevel <= SAVER_BATTERY) return PowerMode.Saver;
  if (state.screenOn || state.msSinceTraffic < ACTIVE_TRAFFIC_MS) return PowerMode.Active;
  return PowerMode.Balanced;
}

/**
 * Turn an observed device state into radio settings.
 *
 * Density is the interesting term. In a crowded mesh a node already has all the
 * neighbours it can use, and everything it would hear by scanning harder is
 * something a neighbour will relay to it anyway — so scanning is nearly pure
 * waste, and it is precisely the crowded case (a festival, a stadium) where
 * battery matters most. Alone, the opposite: scanning is the only way back into
 * the mesh.
 */
export function planRadio(state: DeviceState, mode: PowerMode = selectMode(state)): RadioPlan {
  const profile = PROFILES[mode];

  const neighbours = Math.max(0, state.neighbourCount);
  const densityFactor =
    neighbours === 0 && profile.boostWhenAlone
      ? LONELY_BOOST
      : Math.max(0.25, 1 / (1 + neighbours / 2));

  const duty = clamp(profile.baseDuty * densityFactor, profile.minDuty, profile.maxDuty);
  const { scanWindowMs, scanIntervalMs } = scanSchedule(duty, profile.scanIntervalMs);

  return {
    mode,
    scanWindowMs,
    scanIntervalMs,
    advertiseIntervalMs: clamp(
      profile.advertiseIntervalMs,
      MIN_ADVERTISE_INTERVAL_MS,
      MAX_ADVERTISE_INTERVAL_MS,
    ),
    dutyRatio: scanWindowMs / scanIntervalMs,
  };
}

/**
 * Turn a duty ratio into a concrete window/interval pair.
 *
 * A window below the physical floor cannot simply be shortened further, so the
 * interval is stretched instead. That preserves the duty ratio — and therefore
 * the power budget — while keeping each individual window long enough to
 * actually catch an advertisement.
 *
 * Every profile above is tuned to clear the floor on its own, so in practice
 * this only rounds. It is separate and exported because the floor is a property
 * of BLE, not of our policy: retune `minDuty` or `scanIntervalMs` and this is
 * what stops the result from being a schedule that cannot hear anything.
 */
export function scanSchedule(
  dutyRatio: number,
  preferredIntervalMs: number,
): { scanWindowMs: number; scanIntervalMs: number } {
  const scanWindowMs = Math.round(dutyRatio * preferredIntervalMs);
  if (scanWindowMs >= MIN_SCAN_WINDOW_MS) {
    return { scanWindowMs, scanIntervalMs: preferredIntervalMs };
  }
  return {
    scanWindowMs: MIN_SCAN_WINDOW_MS,
    scanIntervalMs: Math.round(MIN_SCAN_WINDOW_MS / dutyRatio),
  };
}

export interface DutyCycleOptions {
  /** Battery must cross a threshold by this much before the mode changes. */
  hysteresis?: number;
  /** Minimum time in a mode before another switch is allowed. */
  minDwellMs?: number;
}

/**
 * Stateful wrapper that stops the mode flapping.
 *
 * A battery reading sitting exactly on 15% would otherwise toggle Saver and
 * Balanced on every sample, and each toggle restarts the BLE scanner — which
 * costs more power than either mode. Hysteresis plus a dwell time makes the
 * transition sticky in both directions.
 */
export class DutyCycleController {
  private mode: PowerMode | null = null;
  private changedAt = 0;
  private readonly hysteresis: number;
  private readonly minDwellMs: number;

  constructor(options: DutyCycleOptions = {}) {
    this.hysteresis = options.hysteresis ?? 0.03;
    this.minDwellMs = options.minDwellMs ?? 30_000;
  }

  get currentMode(): PowerMode | null {
    return this.mode;
  }

  update(state: DeviceState, now: number): RadioPlan {
    const target = selectMode(state);

    if (this.mode === null) {
      this.mode = target;
      this.changedAt = now;
    } else if (target !== this.mode && this.shouldSwitch(state, target, now)) {
      this.mode = target;
      this.changedAt = now;
    }

    return planRadio(state, this.mode);
  }

  private shouldSwitch(state: DeviceState, target: PowerMode, now: number): boolean {
    // Plugging in or unplugging is an unambiguous physical event, not a noisy
    // sensor reading. Never damp it.
    const chargingChanged =
      (target === PowerMode.Charging) !== (this.mode === PowerMode.Charging);
    if (chargingChanged) return true;

    // Falling into a lower-power mode is always allowed: the risk of being slow
    // to save power is a dead phone, and the risk of being slow to spend it is
    // a few seconds of extra latency.
    if (rank(target) < rank(this.mode!)) return true;

    if (now - this.changedAt < this.minDwellMs) return false;

    // Climbing out needs the battery to be clear of the threshold, not merely
    // touching it.
    if (this.mode === PowerMode.Critical) {
      return state.batteryLevel > CRITICAL_BATTERY + this.hysteresis;
    }
    if (this.mode === PowerMode.Saver) {
      return state.batteryLevel > SAVER_BATTERY + this.hysteresis;
    }
    return true;
  }
}

const ORDER: PowerMode[] = [
  PowerMode.Critical,
  PowerMode.Saver,
  PowerMode.Balanced,
  PowerMode.Active,
  PowerMode.Charging,
];

function rank(mode: PowerMode): number {
  return ORDER.indexOf(mode);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
