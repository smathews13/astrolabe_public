/**
 * How often the watchdog may probe, and why that is not a number somebody picks.
 *
 * THE CONFLICT. Every tick is a real read on a real connection, cancelled by
 * the same statement timeout every other read is cancelled by. The floor on the
 * interval used to be an independently chosen five seconds while that timeout
 * was thirty, and the two were never compared. A deployment slow enough to sit
 * near its read limit would therefore start a probe every five seconds against
 * probes that take thirty to die: six outstanding at once, each holding one of
 * ten pooled connections, and the thing that exists to notice the store
 * struggling becomes most of what it is struggling with. Nothing in either
 * value's own reasoning was wrong. They were wrong about each other.
 *
 * So the floor is DERIVED from the read timeout rather than chosen beside it: a
 * probe cannot outlive that limit, so spacing ticks by at least it means a tick
 * cannot land on an outstanding probe. Neither value can be set into conflict
 * with the other, because there is only one number now.
 *
 * The floor alone is not enough, and the reason is the one case it cannot
 * reach: the timeout can be turned off, and an unlimited probe can outlast any
 * interval. So a tick that finds the previous probe still running is skipped
 * outright, which makes stacking impossible for reasons that do not depend on
 * anything being configured well.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POOL_ENV } from './lakebase-pool';
import {
  WATCHDOG_DEFAULT_INTERVAL_MS,
  WATCHDOG_INTERVAL_ENV,
  WATCHDOG_MIN_INTERVAL_MS,
  resetLakebaseHealth,
  startLakebaseWatchdog,
  stopLakebaseWatchdog,
  watchdogIntervalMs,
  type LakebaseReader,
} from './lakebase-store';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

afterEach(() => {
  stopLakebaseWatchdog();
  resetLakebaseHealth();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the floor under the watchdog interval', () => {
  it('is the read timeout, so a tick cannot land on a probe still running', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const interval = watchdogIntervalMs(
      env({ [POOL_ENV.statementTimeoutMs]: '45000', [WATCHDOG_INTERVAL_ENV]: '1000' })
    );

    expect(interval).toBe(45_000);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * MOVED BY THE TIMEOUT, which is what makes it a relation rather than a
   * coincidence. A floor that happened to equal one deployment's timeout and
   * ignored another's would be the same two independent numbers with a nicer
   * comment on them.
   */
  it('moves when the read timeout moves', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const at = (timeout: string) =>
      watchdogIntervalMs(env({ [POOL_ENV.statementTimeoutMs]: timeout, [WATCHDOG_INTERVAL_ENV]: '1' }));

    expect(at('9000')).toBe(9_000);
    expect(at('20000')).toBe(20_000);
    expect(at('90000')).toBe(90_000);
  });

  /**
   * The default is not exempt. A deployment that lengthened its read timeout
   * past a minute and never touched the watchdog variable would otherwise be
   * left probing every sixty seconds with a probe allowed to live longer than
   * that -- the same conflict, arrived at by leaving something alone.
   */
  it('raises the default interval too, rather than only a configured one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(watchdogIntervalMs(env({ [POOL_ENV.statementTimeoutMs]: '120000' }))).toBe(120_000);
    // And leaves it alone when there is no conflict to resolve.
    expect(watchdogIntervalMs(env({ [POOL_ENV.statementTimeoutMs]: '30000' }))).toBe(WATCHDOG_DEFAULT_INTERVAL_MS);
  });

  /**
   * With the timeout off there is no probe lifetime to derive anything from, so
   * the old absolute floor is what is left. It stops a typo of `500` for
   * `500000`; it cannot stop an unlimited probe, and the skip below is what
   * does.
   */
  it('falls back to the absolute floor when the timeout is switched off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(watchdogIntervalMs(env({ [POOL_ENV.statementTimeoutMs]: '0', [WATCHDOG_INTERVAL_ENV]: '10' }))).toBe(
      WATCHDOG_MIN_INTERVAL_MS
    );
  });
});

describe('a tick that arrives while the last probe is still out', () => {
  /**
   * THE STRUCTURAL HALF. Asserted with a read that never answers, because that
   * is the case no interval can be chosen around: the timeout is off, or the
   * connection is hung below it. However often the timer fires, one probe is
   * outstanding, and one connection is held.
   */
  it('is skipped, so the probe cannot become the load', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let asked = 0;
    const client: LakebaseReader = {
      lakebase: {
        query: () => {
          asked += 1;
          return new Promise(() => {});
        },
      },
    };

    startLakebaseWatchdog(client, 5_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(asked).toBe(1);
  });

  /** And once it answers, probing resumes on the next tick. */
  it('resumes when the probe finally answers', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let asked = 0;
    const pending: ((rows: { rows: Record<string, unknown>[] }) => void)[] = [];
    const client: LakebaseReader = {
      lakebase: {
        query: () => {
          asked += 1;
          return new Promise((resolve) => pending.push(resolve));
        },
      },
    };

    startLakebaseWatchdog(client, 5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asked).toBe(1);

    pending[0]({ rows: [{ conversations: 1 }] });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(asked).toBe(2);
  });
});
