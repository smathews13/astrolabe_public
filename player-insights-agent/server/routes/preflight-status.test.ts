/**
 * The status code /api/preflight answers with.
 *
 * A separate file from insights-routes.test.ts, which boots the whole app: the
 * rule under test is a pure function of a report, and this is the one property
 * a release script or an uptime check reads. Kept apart so it stays readable as
 * the contract rather than as one assertion inside a route test.
 */
import { describe, expect, it } from 'vitest';

import {
  countChecks,
  overallStatus,
  preflightHttpStatus,
  type PreflightCheck,
  type PreflightReport,
} from './insights-routes';

function check(id: string, status: PreflightCheck['status']): PreflightCheck {
  return {
    id,
    kind: 'dependency',
    name: id,
    label: id,
    status,
    detail: '',
    checked_with: 'app',
    duration_ms: 0,
    error: '',
    remedy: null,
  };
}

function report(...checks: PreflightCheck[]): PreflightReport {
  return {
    checked_at: '2026-08-10T14:00:00.000Z',
    status: overallStatus(checks),
    principal: '',
    principal_resolved: false,
    table_source: 'unknown',
    build_sha: '',
    configuration: [],
    checks,
    assumptions: [],
    counts: countChecks(checks),
    source: 'app',
  };
}

describe('the status code a preflight report is served with', () => {
  it('answers 503 when a dependency failed, so a poller sees it', () => {
    // The whole point. Everything that reads a status code rather than a body
    // was told this app was well while its store was unreadable.
    expect(preflightHttpStatus(report(check('lakebase-storage', 'failed')))).toBe(503);
  });

  it('answers 200 when everything checked passed', () => {
    expect(preflightHttpStatus(report(check('agent-endpoint', 'ok')))).toBe(200);
  });

  it('answers 200 for a check that did not run, which is not a check that failed', () => {
    // Refusing here would take the app's own explanation of why it is degraded
    // off the air on exactly the days somebody needs to read it.
    expect(preflightHttpStatus(report(check('genie-space', 'unverified')))).toBe(200);
  });

  it('answers 200 for a report with no checks at all rather than declaring an outage', () => {
    expect(preflightHttpStatus(report())).toBe(200);
  });

  it('follows the report rather than a second opinion about it', () => {
    // Derived from `status`, so a caller that recomputed the totals and a
    // caller that trusted them cannot disagree about whether the app is up.
    const failing = report(check('agent-endpoint', 'ok'), check('lakebase-storage', 'failed'));
    expect(failing.status).toBe('failed');
    expect(preflightHttpStatus(failing)).toBe(503);
  });
});
