/**
 * The two semantic rows nothing probes, and why they say what they say.
 *
 * Both used to arrive with no check at all, which the page renders as `Not
 * checked` with the generic note: "no check has run against this one yet". On a
 * deployment whose index reports `true` rather than a resolved name, and on one
 * whose index was refused, nobody was ever going to run one -- so the row
 * promised a verdict that was not coming and gave the reader nothing to do.
 *
 * The app holds the reason in both cases, so it states it.
 */
import { describe, expect, it } from 'vitest';
import { withSemanticFollowUps } from './dependency-probes';
// The SERVER's check type, which is the one the function under test takes. The
// client declares a `PreflightCheck` of its own, structurally similar and not
// the same type: the server's is inferred from the zod schema and carries an
// index signature the client's does not, so passing the client's here failed the
// typecheck on five lines while vitest, which does not typecheck, ran green.
import type { PreflightCheck } from '../routes/insights-routes';

function check(id: string, status: PreflightCheck['status']): PreflightCheck {
  return {
    id,
    kind: 'vector-index',
    name: '',
    label: id,
    status,
    detail: 'measured',
    checked_with: '',
    duration_ms: 1,
    error: '',
    remedy: null,
  };
}

const byId = (checks: readonly PreflightCheck[], id: string) => checks.find((entry) => entry.id === id);

describe('a release that searches no index is left alone', () => {
  it('adds nothing when the index is unset', () => {
    const checks = [check('sql-warehouse', 'ok')];
    expect(withSemanticFollowUps(checks, {})).toEqual(checks);
    expect(withSemanticFollowUps(checks, { 'semantic-index': '  ' })).toEqual(checks);
  });
});

describe('an index the app cannot name', () => {
  const configured = { 'semantic-index': 'true' };

  it('says the version reports a flag rather than a name', () => {
    const added = byId(withSemanticFollowUps([], configured), 'semantic-index');
    expect(added?.status).toBe('unverified');
    expect(added?.detail).toContain('rather than as the resolved three-level name');
    // The remedy is a re-log, and no GRANT would help. Sending an admin after a
    // permission for this would be sending them nowhere.
    expect(added?.remedy).toBeNull();
    expect(added?.detail).toContain('Re-logging the model');
  });

  it('says the endpoint could not be named either, and why', () => {
    const added = byId(withSemanticFollowUps([], configured), 'semantic-index-endpoint');
    expect(added?.status).toBe('unverified');
    expect(added?.detail).toContain('Only the index names the endpoint serving it');
  });
});

describe('an index that answered', () => {
  const configured = { 'semantic-index': 'a.b.c' };

  it('leaves a real verdict alone rather than restating it', () => {
    const measured = [check('semantic-index', 'ok'), check('semantic-index-endpoint', 'failed')];
    expect(withSemanticFollowUps(measured, configured)).toEqual(measured);
  });

  it('explains the endpoint when the index was refused', () => {
    const settled = withSemanticFollowUps([check('semantic-index', 'failed')], configured);
    // The index keeps the verdict it earned. Only the endpoint gains a reason.
    expect(byId(settled, 'semantic-index')?.status).toBe('failed');
    expect(byId(settled, 'semantic-index')?.detail).toBe('measured');
    expect(byId(settled, 'semantic-index-endpoint')?.detail).toContain('the index did not answer');
  });

  it('explains the endpoint when the index was refused for want of a scope', () => {
    // `unverified` is what a scope refusal produces, and it is not a pass: the
    // endpoint's name was still never learned.
    const settled = withSemanticFollowUps([check('semantic-index', 'unverified')], configured);
    expect(byId(settled, 'semantic-index-endpoint')?.status).toBe('unverified');
  });
});
