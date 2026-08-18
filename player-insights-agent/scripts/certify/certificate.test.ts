import { describe, expect, it } from 'vitest';
import {
  acceptCertificate,
  admitAttestation,
  certificateDigest,
  issueCertificate,
  verdict,
  type Attestation,
  type CheckResult,
} from './certificate.ts';
import { REQUIRED_CODES } from './catalogue.ts';
import { emptyTuple, tupleDigest, type ReleaseTuple } from './release-identity.ts';

const TUPLE: ReleaseTuple = {
  ...emptyTuple(),
  target: 'demo',
  appName: 'player-insights-agent',
  appBuildSha: 'a'.repeat(40),
  servingEndpoint: 'player-insights-agent',
  modelName: 'cat.sch.model',
  modelVersion: '19',
  modelBuildSha: 'a'.repeat(40),
  declaredScopes: ['sql'],
};
const DIGEST = tupleDigest(TUPLE);

function passing(code: string): CheckResult {
  return { code, status: 'pass', detail: 'observed', durationMs: 1 };
}

/** Every required check passing, which is the only route to a bare PASS. */
function allRequiredPassing(): CheckResult[] {
  return REQUIRED_CODES.map(passing);
}

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    code: 'OAUTH_SCOPE_CONSENT_PROVEN',
    by: 'someone@example.com',
    at: '2026-08-10T00:00:00.000Z',
    note: 'Signed in after the restart and reached the app.',
    tupleDigest: DIGEST,
    ...overrides,
  };
}

describe('admitAttestation', () => {
  it('admits a complete statement about something nothing can observe', () => {
    expect(admitAttestation(attestation(), DIGEST)).toEqual({ admitted: true });
  });

  it('refuses a statement about a check an API answers', () => {
    const decision = admitAttestation(attestation({ code: 'OAUTH_SCOPES_IN_EFFECT' }), DIGEST);
    expect(decision).toMatchObject({ admitted: false });
    expect(decision).toHaveProperty('reason', expect.stringContaining('Run the check'));
  });

  it('refuses a statement made against a different release', () => {
    const decision = admitAttestation(attestation({ tupleDigest: 'somethingelse' }), DIGEST);
    expect(decision).toMatchObject({ admitted: false });
    expect(decision).toHaveProperty('reason', expect.stringContaining('different release'));
  });

  it('refuses an unsigned statement', () => {
    expect(admitAttestation(attestation({ by: '  ' }), DIGEST)).toMatchObject({ admitted: false });
  });

  it('refuses a statement that records no observation', () => {
    expect(admitAttestation(attestation({ note: '' }), DIGEST)).toMatchObject({ admitted: false });
  });

  it('refuses a code the catalogue does not have', () => {
    expect(admitAttestation(attestation({ code: 'MADE_UP' }), DIGEST)).toMatchObject({ admitted: false });
  });
});

describe('verdict', () => {
  it('is PASS when every required check passed', () => {
    const outcome = verdict({ checks: allRequiredPassing(), attestations: [], tupleDigest: DIGEST });
    expect(outcome.status).toBe('PASS');
    expect(outcome.failed).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  });

  it('is INCOMPLETE when a required check was never emitted', () => {
    const checks = allRequiredPassing().filter((check) => check.code !== 'LAKEBASE_STORAGE_READABLE');
    const outcome = verdict({ checks, attestations: [], tupleDigest: DIGEST });
    expect(outcome.status).toBe('INCOMPLETE');
    expect(outcome.unresolved).toContain('LAKEBASE_STORAGE_READABLE');
  });

  it('is INCOMPLETE, not PASS, when a required check came back unknown', () => {
    const checks = allRequiredPassing().map((check) =>
      check.code === 'POSTGRES_SCHEMA_OWNERSHIP'
        ? { ...check, status: 'unknown' as const, detail: 'could not run' }
        : check
    );
    const outcome = verdict({ checks, attestations: [], tupleDigest: DIGEST });
    expect(outcome.status).toBe('INCOMPLETE');
    expect(outcome.unresolved).toEqual(['POSTGRES_SCHEMA_OWNERSHIP']);
  });

  it('is FAIL when a required check failed, even alongside unresolved ones', () => {
    const checks = allRequiredPassing().map((check) =>
      check.code === 'OAUTH_SCOPES_IN_EFFECT'
        ? { ...check, status: 'fail' as const, detail: 'sql not in effect' }
        : check
    );
    const outcome = verdict({ checks, attestations: [], tupleDigest: DIGEST });
    expect(outcome.status).toBe('FAIL');
    expect(outcome.failed).toEqual(['OAUTH_SCOPES_IN_EFFECT']);
  });

  it('lets an admitted statement resolve an unverifiable check', () => {
    const checks = allRequiredPassing().map((check) =>
      check.code === 'OAUTH_SCOPE_CONSENT_PROVEN'
        ? { ...check, status: 'unverifiable' as const, detail: 'no API answers this' }
        : check
    );
    const outcome = verdict({ checks, attestations: [attestation()], tupleDigest: DIGEST });
    expect(outcome.status).toBe('PASS');
  });

  it('never lets a statement stand over a check that actually failed', () => {
    // The whole gate turns into paperwork the moment this is possible.
    const checks = allRequiredPassing().map((check) =>
      check.code === 'CLIENT_RENDERS_UNAVAILABLE'
        ? { ...check, status: 'fail' as const, detail: 'it rendered a fabricated row' }
        : check
    );
    const outcome = verdict({
      checks,
      attestations: [attestation({ code: 'CLIENT_RENDERS_UNAVAILABLE' })],
      tupleDigest: DIGEST,
    });
    expect(outcome.status).toBe('FAIL');
    expect(outcome.failed).toEqual(['CLIENT_RENDERS_UNAVAILABLE']);
  });

  it('reports a rejected statement rather than dropping it silently', () => {
    const outcome = verdict({
      checks: allRequiredPassing(),
      attestations: [attestation({ tupleDigest: 'stale' })],
      tupleDigest: DIGEST,
    });
    expect(outcome.rejectedAttestations).toHaveLength(1);
    expect(outcome.rejectedAttestations[0].code).toBe('OAUTH_SCOPE_CONSENT_PROVEN');
  });

  it('ignores an advisory check that failed', () => {
    const checks = [
      ...allRequiredPassing(),
      { code: 'APP_MODEL_BUILD_MATCH', status: 'fail' as const, detail: 'skew', durationMs: 0 },
    ];
    expect(verdict({ checks, attestations: [], tupleDigest: DIGEST }).status).toBe('PASS');
  });
});

describe('issueCertificate', () => {
  it('records the verdict and a digest over its own contents', () => {
    const certificate = issueCertificate({
      tuple: TUPLE,
      checks: allRequiredPassing(),
      attestations: [],
      mode: 'blocking',
      issuedBy: 'someone@example.com',
      now: new Date('2026-08-10T09:00:00.000Z'),
    });
    expect(certificate.status).toBe('PASS');
    expect(certificate.tupleDigest).toBe(DIGEST);
    const { digest, ...body } = certificate;
    expect(certificateDigest(body)).toBe(digest);
  });

  it('expires, so a certificate cannot outlive the live state it measured', () => {
    const certificate = issueCertificate({
      tuple: TUPLE,
      checks: [],
      attestations: [],
      mode: 'shadow',
      issuedBy: 'someone@example.com',
      now: new Date('2026-08-10T09:00:00.000Z'),
      ttlMs: 60_000,
    });
    expect(certificate.expiresAt).toBe('2026-08-10T09:01:00.000Z');
  });
});

describe('acceptCertificate', () => {
  function accepted(overrides: Partial<Parameters<typeof issueCertificate>[0]> = {}) {
    return issueCertificate({
      tuple: TUPLE,
      checks: allRequiredPassing(),
      attestations: [],
      mode: 'blocking',
      issuedBy: 'someone@example.com',
      now: new Date('2026-08-10T09:00:00.000Z'),
      ...overrides,
    });
  }

  const soonAfter = new Date('2026-08-10T09:05:00.000Z');

  it('accepts a fresh, matching, blocking PASS', () => {
    const decision = acceptCertificate({ certificate: accepted(), tuple: TUPLE, now: soonAfter });
    expect(decision).toEqual({ accepted: true, reasons: [] });
  });

  it('refuses one whose contents were edited after issue', () => {
    const certificate = { ...accepted(), status: 'PASS' as const, issuedBy: 'someone-else@example.com' };
    const decision = acceptCertificate({ certificate, tuple: TUPLE, now: soonAfter });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(' ')).toContain('altered since it was issued');
  });

  it('refuses one issued for a different release', () => {
    const moved = { ...TUPLE, modelVersion: '20' };
    const decision = acceptCertificate({ certificate: accepted(), tuple: moved, now: soonAfter });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(' ')).toContain('different release');
  });

  it('refuses an expired one rather than extending it', () => {
    const decision = acceptCertificate({
      certificate: accepted(),
      tuple: TUPLE,
      now: new Date('2026-08-12T09:00:00.000Z'),
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(' ')).toContain('expired');
  });

  it('refuses a shadow certificate, which was never a decision', () => {
    const decision = acceptCertificate({
      certificate: accepted({ mode: 'shadow' }),
      tuple: TUPLE,
      now: soonAfter,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.join(' ')).toContain('shadow mode');
  });

  it('collects every reason, because the operator is about to decide whether to override', () => {
    const stale = accepted({ mode: 'shadow', checks: [] });
    const decision = acceptCertificate({
      certificate: stale,
      tuple: { ...TUPLE, modelVersion: '21' },
      now: new Date('2026-08-12T09:00:00.000Z'),
    });
    expect(decision.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('stops at an unreadable schema rather than deriving findings from an unknown shape', () => {
    const alien = { ...accepted(), schema: 2 as unknown as 1 };
    const decision = acceptCertificate({ certificate: alien, tuple: TUPLE, now: soonAfter });
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toContain('cannot read');
  });
});
