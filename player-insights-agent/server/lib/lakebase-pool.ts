/**
 * How the app's Postgres pool is sized, and how a hung statement is cut off.
 *
 * ── WHAT WAS ALREADY FINE ──
 *
 * AppKit's Lakebase plugin does size its pool: `@databricks/lakebase` defaults to
 * `max: 10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`
 * (`dist/config.js`). None of those is unbounded, so nothing here needs to fix
 * them. {@link lakebasePoolSettings} states them as this deployment's own numbers
 * and makes them tunable, so a load problem can be answered by an environment
 * variable rather than by a release.
 *
 * ── WHAT WAS NOT, AND WHY PASSING IT TO APPKIT DOES NOTHING ──
 *
 * A statement timeout was the missing one, and the obvious fix is a trap.
 * `lakebase({ pool: { statement_timeout: 30_000 } })` type-checks, because
 * `LakebasePoolConfig extends pg.PoolConfig` and `statement_timeout` is a
 * `pg.PoolConfig` field. It then does nothing at all:
 * `getLakebasePgConfig` in `@databricks/lakebase/dist/pool-config.js` does not
 * spread the caller's config, it REBUILDS one from nine named fields
 * (`host`, `port`, `user`, `database`, `password`, `ssl`, `max`,
 * `idleTimeoutMillis`, `connectionTimeoutMillis`). `statement_timeout`,
 * `query_timeout` and `options` are all dropped on the floor, silently, with no
 * warning and a healthy-looking boot.
 *
 * So the timeout is applied where it can be observed working: as a session
 * setting on each pooled connection, by {@link lakebase-store}'s read funnel.
 * See `statementTimeoutSql` below and `applySessionTimeout` there.
 */

/** Environment variable names, in one place so a doc and a reader cannot disagree. */
export const POOL_ENV = {
  max: 'PLAYER_INSIGHTS_DB_POOL_MAX',
  idleTimeoutMs: 'PLAYER_INSIGHTS_DB_IDLE_TIMEOUT_MS',
  connectionTimeoutMs: 'PLAYER_INSIGHTS_DB_CONNECT_TIMEOUT_MS',
  statementTimeoutMs: 'PLAYER_INSIGHTS_DB_STATEMENT_TIMEOUT_MS',
} as const;

/**
 * The numbers this deployment runs with, which are AppKit's own defaults stated
 * out loud rather than different ones.
 */
export const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
  /**
   * Long enough that no read this app issues can reach it while working
   * correctly, short enough that a pathological one gives its connection back
   * within the timeframe a person is still watching the page. The monitoring
   * questions read, the slowest thing here, is bounded by page size after the
   * Arch#1 rewrite and answers a 100k-message store in well under a second.
   */
  statementTimeoutMs: 30_000,
} as const;

/**
 * A positive integer from the environment, or the default.
 *
 * Anything unparseable, zero or negative falls back rather than being coerced:
 * a typo in a deployment variable must not silently become `max: NaN`, which
 * `pg` reads as "one connection, forever".
 */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface LakebasePoolSettings {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * What to hand `lakebase({ pool })`. Only fields AppKit actually forwards, so
 * nothing here can look configured while being discarded.
 */
export function lakebasePoolSettings(env: NodeJS.ProcessEnv = process.env): LakebasePoolSettings {
  return {
    max: positiveInteger(env[POOL_ENV.max], POOL_DEFAULTS.max),
    idleTimeoutMillis: positiveInteger(env[POOL_ENV.idleTimeoutMs], POOL_DEFAULTS.idleTimeoutMs),
    connectionTimeoutMillis: positiveInteger(env[POOL_ENV.connectionTimeoutMs], POOL_DEFAULTS.connectionTimeoutMs),
  };
}

/**
 * The statement timeout in milliseconds, or 0 to leave it unset.
 *
 * `0` is how a deployment turns it off, and it is spelled as the same value
 * Postgres itself uses for "no limit" so the two cannot mean opposite things.
 */
export function statementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[POOL_ENV.statementTimeoutMs] ?? '').trim();
  if (raw === '0') return 0;
  return positiveInteger(raw, POOL_DEFAULTS.statementTimeoutMs);
}

/**
 * The `SET` that applies it, or null when it is switched off.
 *
 * The value is re-derived as an integer here rather than interpolated from the
 * environment string. `SET` takes no parameters, so this is the one place in the
 * app that builds SQL by concatenation, and the only safe way to do that is for
 * the concatenated value to be a number this function produced.
 */
export function statementTimeoutSql(env: NodeJS.ProcessEnv = process.env): string | null {
  const ms = statementTimeoutMs(env);
  if (ms <= 0) return null;
  return `SET statement_timeout = ${Math.round(ms)}`;
}

/**
 * Postgres's code for a statement it cancelled on the timeout above.
 *
 * Named because the distinction matters twice: it must never be retried (a
 * retry of a query too slow to finish is two queries too slow to finish), and it
 * must never be reported as an outage or a missing grant, which are the two
 * other reasons a read comes back without rows.
 */
export const STATEMENT_TIMEOUT_CODE = '57014';
