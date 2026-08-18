/**
 * What the running model is compared against, and the values that must not be
 * compared at all.
 *
 * The hazard this covers is the one `app-settings.ts` documents for the same class
 * of guard: a value nobody can read becoming a value that loudly disagrees. On this
 * page that is an amber row about a healthy deployment, and the notebook comparison
 * is a new way to reach it, because a published key is matched against whatever the
 * configuration report happened to carry for that name.
 *
 * Every identifier is invented.
 */
import { describe, expect, it } from 'vitest';

import { liveConfiguration } from './settings-routes';
import { compareDeclaration, parseDeclaration } from '../../shared/notebook-declaration';
import type { PreflightConfiguration, PreflightReport } from './insights-routes';

function report(configuration: PreflightConfiguration[]): PreflightReport {
  return {
    checked_at: '',
    status: 'unverified',
    principal: '',
    principal_resolved: false,
    table_source: '',
    build_sha: '',
    configuration,
    checks: [],
    assumptions: [],
    counts: { ok: 0, failed: 0, unverified: 0 },
    source: 'configuration',
  } as unknown as PreflightReport;
}

function entry(key: string, value: unknown): PreflightConfiguration {
  return { key, value } as unknown as PreflightConfiguration;
}

describe('the values a declaration is compared against', () => {
  it('reads a plain string', () => {
    expect(liveConfiguration(report([entry('warehouse_id', 'wh-00000000000000aa')]))).toEqual({
      warehouse_id: 'wh-00000000000000aa',
    });
  });

  it('reads a number and a boolean as their text', () => {
    expect(liveConfiguration(report([entry('max_output_tokens', 2500), entry('some_flag', true)]))).toEqual({
      max_output_tokens: '2500',
      some_flag: 'true',
    });
  });

  /**
   * A published scope list is a comma-separated string, so the live one has to be
   * joined the same way or every deployment would report a disagreement it does not
   * have.
   */
  it('joins a list the way a notebook publishes one', () => {
    expect(liveConfiguration(report([entry('catalog_allowlist', ['one_scope', 'two_scope'])]))).toEqual({
      catalog_allowlist: 'one_scope,two_scope',
    });
  });

  /**
   * The guard that matters. `String(object)` is '[object Object]', which is
   * non-empty, so it would be compared against the published value, disagree, and
   * draw an amber row about a deployment that is fine.
   */
  it('skips a value that is not a readable scalar rather than stringifying it', () => {
    const live = liveConfiguration(report([entry('warehouse_id', { nested: true }), entry('catalog', ['ok'])]));
    expect(live).not.toHaveProperty('warehouse_id');
    expect(live.catalog).toBe('ok');
  });

  it('skips a mixed list rather than reading half of it', () => {
    expect(liveConfiguration(report([entry('catalog_allowlist', ['fine', { nested: true }])]))).toEqual({});
  });

  it('skips an entry with no key', () => {
    expect(liveConfiguration(report([entry('', 'orphan')]))).toEqual({});
  });

  it('reads nothing from a report that is not there', () => {
    expect(liveConfiguration(null)).toEqual({});
  });
});

describe('what an unreadable live value does to the comparison', () => {
  const declaration = parseDeclaration({
    settings: { warehouse_id: 'wh-00000000000000aa' },
    connections: [],
  });

  it('reads as unknown rather than as a disagreement', () => {
    const live = liveConfiguration(report([entry('warehouse_id', { nested: true })]));
    const [compared] = compareDeclaration(declaration!, live);
    expect(compared.verdict).toBe('unknown');
  });

  it('agrees once the live value is readable and the same', () => {
    const live = liveConfiguration(report([entry('warehouse_id', 'wh-00000000000000aa')]));
    const [compared] = compareDeclaration(declaration!, live);
    expect(compared.verdict).toBe('agrees');
  });
});
