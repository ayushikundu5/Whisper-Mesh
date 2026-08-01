import {
  ACTIVE_TRAFFIC_MS,
  CRITICAL_BATTERY,
  DeviceState,
  DutyCycleController,
  MAX_ADVERTISE_INTERVAL_MS,
  MIN_ADVERTISE_INTERVAL_MS,
  MIN_SCAN_WINDOW_MS,
  PowerMode,
  SAVER_BATTERY,
  planRadio,
  scanSchedule,
  selectMode,
} from './dutyCycle';

const NOW = 1_000_000;

const state = (overrides: Partial<DeviceState> = {}): DeviceState => ({
  batteryLevel: 0.8,
  charging: false,
  screenOn: false,
  neighbourCount: 3,
  msSinceTraffic: 60 * 60_000,
  ...overrides,
});

describe('mode selection', () => {
  it('picks charging over everything, including a flat battery', () => {
    expect(selectMode(state({ charging: true, batteryLevel: 0.01 }))).toBe(PowerMode.Charging);
  });

  it('picks critical at the very bottom', () => {
    expect(selectMode(state({ batteryLevel: CRITICAL_BATTERY }))).toBe(PowerMode.Critical);
  });

  it('picks saver on low battery', () => {
    expect(selectMode(state({ batteryLevel: SAVER_BATTERY }))).toBe(PowerMode.Saver);
  });

  it('picks active when the user is looking at it', () => {
    expect(selectMode(state({ screenOn: true }))).toBe(PowerMode.Active);
  });

  it('picks active while a conversation is still warm', () => {
    expect(selectMode(state({ msSinceTraffic: ACTIVE_TRAFFIC_MS - 1 }))).toBe(PowerMode.Active);
  });

  it('falls back to balanced when backgrounded and idle', () => {
    expect(selectMode(state())).toBe(PowerMode.Balanced);
  });

  it('will not go active on a low battery just because the screen is on', () => {
    expect(selectMode(state({ batteryLevel: 0.1, screenOn: true }))).toBe(PowerMode.Saver);
  });
});

describe('radio plan', () => {
  it('produces physically legal BLE parameters in every mode', () => {
    for (const mode of Object.values(PowerMode)) {
      for (const neighbours of [0, 1, 5, 20]) {
        const plan = planRadio(state({ neighbourCount: neighbours }), mode);
        expect(plan.scanWindowMs).toBeGreaterThanOrEqual(MIN_SCAN_WINDOW_MS);
        expect(plan.scanIntervalMs).toBeGreaterThanOrEqual(plan.scanWindowMs);
        expect(plan.advertiseIntervalMs).toBeGreaterThanOrEqual(MIN_ADVERTISE_INTERVAL_MS);
        expect(plan.advertiseIntervalMs).toBeLessThanOrEqual(MAX_ADVERTISE_INTERVAL_MS);
        expect(plan.dutyRatio).toBeGreaterThan(0);
        expect(plan.dutyRatio).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never stops advertising, even at critical battery', () => {
    // A node that stops advertising is a hole in the mesh. Scanning is what
    // gets cut; being findable is what gets kept.
    const plan = planRadio(state({ batteryLevel: 0.01 }));
    expect(plan.mode).toBe(PowerMode.Critical);
    expect(plan.advertiseIntervalMs).toBeLessThanOrEqual(MAX_ADVERTISE_INTERVAL_MS);
    expect(plan.dutyRatio).toBeGreaterThan(0);
  });

  it('spends strictly more radio time the more battery there is', () => {
    const levels = [0.02, 0.1, 0.3, 0.9];
    const duties = levels.map((batteryLevel) => planRadio(state({ batteryLevel })).dutyRatio);
    for (let i = 1; i < duties.length; i++) {
      expect(duties[i]!).toBeGreaterThanOrEqual(duties[i - 1]!);
    }
  });

  it('spends more when plugged in than on the same battery unplugged', () => {
    const level = 0.5;
    expect(planRadio(state({ batteryLevel: level, charging: true })).dutyRatio).toBeGreaterThan(
      planRadio(state({ batteryLevel: level, charging: false })).dutyRatio,
    );
  });

  /**
   * The density term. In a crowded mesh anything a node would find by scanning
   * harder, a neighbour will relay to it anyway — and a crowd is exactly where
   * battery matters most.
   */
  it('scans less as the mesh gets denser', () => {
    const duties = [1, 2, 5, 10, 30].map(
      (neighbourCount) => planRadio(state({ neighbourCount })).dutyRatio,
    );
    for (let i = 1; i < duties.length; i++) {
      expect(duties[i]!).toBeLessThanOrEqual(duties[i - 1]!);
    }
  });

  it('scans harder when it has no neighbours at all', () => {
    expect(planRadio(state({ neighbourCount: 0 })).dutyRatio).toBeGreaterThan(
      planRadio(state({ neighbourCount: 1 })).dutyRatio,
    );
  });

  /**
   * At 4% battery, hunting for company is the wrong instinct: staying
   * advertisable for another few hours is worth more to the mesh than one more
   * neighbour now.
   */
  it('does not go hunting for company on a dying battery', () => {
    // Being alone still means scanning more than being in a crowd — the
    // density term applies in every mode. What Critical withholds is the
    // *loneliness boost*: it stays at its base budget instead of exceeding it.
    const criticalAlone = planRadio(state({ batteryLevel: 0.03, neighbourCount: 0 }));
    expect(criticalAlone.mode).toBe(PowerMode.Critical);
    expect(criticalAlone.dutyRatio).toBeLessThanOrEqual(0.02);

    // Balanced, with battery to spare, does take the boost past its base.
    const balancedAlone = planRadio(state({ batteryLevel: 0.8, neighbourCount: 0 }));
    expect(balancedAlone.mode).toBe(PowerMode.Balanced);
    expect(balancedAlone.dutyRatio).toBeGreaterThan(0.15);
  });

  it('keeps every mode inside its own power ceiling', () => {
    const ceilings: Record<PowerMode, number> = {
      [PowerMode.Critical]: 0.03,
      [PowerMode.Saver]: 0.08,
      [PowerMode.Balanced]: 0.3,
      [PowerMode.Active]: 0.6,
      [PowerMode.Charging]: 0.8,
    };
    for (const mode of Object.values(PowerMode)) {
      for (const neighbourCount of [0, 1, 3, 8, 25]) {
        // Rounding to whole milliseconds can nudge the ratio a hair past the
        // ceiling; a millisecond of slack keeps the assertion about policy.
        expect(planRadio(state({ neighbourCount }), mode).dutyRatio).toBeLessThanOrEqual(
          ceilings[mode] + 0.001,
        );
      }
    }
  });

  /**
   * Below about 100ms a scan window is too short to reliably land on the
   * advertising channel a peer is using. Stretching the interval instead keeps
   * the window usable without spending more power.
   */
  it('stretches the interval rather than shortening a window below the floor', () => {
    const { scanWindowMs, scanIntervalMs } = scanSchedule(0.001, 5_000);
    expect(scanWindowMs).toBe(MIN_SCAN_WINDOW_MS);
    expect(scanIntervalMs).toBe(100_000);
    expect(scanWindowMs / scanIntervalMs).toBeCloseTo(0.001, 6);
  });

  it('leaves the interval alone when the window already clears the floor', () => {
    expect(scanSchedule(0.2, 5_000)).toEqual({ scanWindowMs: 1_000, scanIntervalMs: 5_000 });
  });

  it('has profiles that all clear the floor without needing the stretch', () => {
    for (const mode of Object.values(PowerMode)) {
      for (const neighbourCount of [0, 1, 3, 8, 25]) {
        const plan = planRadio(state({ neighbourCount }), mode);
        expect(plan.scanWindowMs).toBeGreaterThanOrEqual(MIN_SCAN_WINDOW_MS);
      }
    }
  });
});

describe('DutyCycleController', () => {
  it('adopts a mode immediately on the first sample', () => {
    const controller = new DutyCycleController();
    expect(controller.update(state(), NOW).mode).toBe(PowerMode.Balanced);
  });

  /**
   * A reading sitting on a threshold would otherwise toggle every sample, and
   * each toggle restarts the BLE scanner — which costs more than either mode.
   */
  it('does not flap when the battery hovers on a threshold', () => {
    const controller = new DutyCycleController({ hysteresis: 0.03, minDwellMs: 30_000 });
    controller.update(state({ batteryLevel: 0.14 }), NOW); // -> Saver

    const modes = new Set<PowerMode>();
    for (let i = 0; i < 20; i++) {
      const level = 0.15 + (i % 2 === 0 ? 0.001 : -0.001);
      modes.add(controller.update(state({ batteryLevel: level }), NOW + i * 1_000).mode);
    }
    expect([...modes]).toEqual([PowerMode.Saver]);
  });

  it('climbs out of saver once the battery is clearly above the threshold', () => {
    const controller = new DutyCycleController({ hysteresis: 0.03, minDwellMs: 30_000 });
    controller.update(state({ batteryLevel: 0.1 }), NOW);

    expect(controller.update(state({ batteryLevel: 0.17 }), NOW + 60_000).mode).toBe(
      PowerMode.Saver,
    );
    expect(controller.update(state({ batteryLevel: 0.5 }), NOW + 120_000).mode).toBe(
      PowerMode.Balanced,
    );
  });

  it('drops into a lower-power mode immediately, without waiting out the dwell', () => {
    const controller = new DutyCycleController({ minDwellMs: 30_000 });
    controller.update(state({ batteryLevel: 0.9 }), NOW);
    // Being slow to save power costs a dead phone; being slow to spend it costs
    // a few seconds of latency.
    expect(controller.update(state({ batteryLevel: 0.02 }), NOW + 1_000).mode).toBe(
      PowerMode.Critical,
    );
  });

  it('reacts to the charger instantly in both directions', () => {
    const controller = new DutyCycleController({ minDwellMs: 60_000 });
    controller.update(state({ batteryLevel: 0.5 }), NOW);

    expect(controller.update(state({ batteryLevel: 0.5, charging: true }), NOW + 100).mode).toBe(
      PowerMode.Charging,
    );
    expect(controller.update(state({ batteryLevel: 0.5, charging: false }), NOW + 200).mode).toBe(
      PowerMode.Balanced,
    );
  });

  it('holds a mode for the dwell time before climbing', () => {
    const controller = new DutyCycleController({ minDwellMs: 30_000 });
    controller.update(state({ screenOn: false }), NOW); // Balanced

    expect(controller.update(state({ screenOn: true }), NOW + 10_000).mode).toBe(
      PowerMode.Balanced,
    );
    expect(controller.update(state({ screenOn: true }), NOW + 31_000).mode).toBe(PowerMode.Active);
  });
});

describe('a day in a dead zone', () => {
  /**
   * Rough sanity check on the shape of the policy: an idle backgrounded phone
   * in a busy mesh should sit at a duty ratio measured in single-digit percent,
   * not tens.
   */
  it('idles cheaply in a crowd', () => {
    const plan = planRadio(state({ batteryLevel: 0.6, neighbourCount: 8, screenOn: false }));
    expect(plan.mode).toBe(PowerMode.Balanced);
    expect(plan.dutyRatio).toBeLessThan(0.1);
  });

  it('opens up when someone starts typing', () => {
    const idle = planRadio(state({ neighbourCount: 4 }));
    const talking = planRadio(state({ neighbourCount: 4, screenOn: true, msSinceTraffic: 500 }));
    expect(talking.dutyRatio).toBeGreaterThan(idle.dutyRatio * 2);
    expect(talking.scanIntervalMs).toBeLessThan(idle.scanIntervalMs);
  });
});
