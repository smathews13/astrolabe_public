import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_MS, coverage, credentialLifetime, endsTheSuite } from './benchmark-identity';

/**
 * The credential a long-running benchmark holds.
 *
 * These tests are mostly about the two states that are easy to get backwards:
 * a token that says nothing about its own lifetime, and a token that says
 * something that does not cover the run.
 */

const NOW = Date.parse('2026-08-05T07:00:00.000Z');

/** A JWT with the given claims. Unsigned: nothing here reads the signature. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

describe('reading how long a credential is good for', () => {
  it('reads exp, in seconds, and reports it in milliseconds', () => {
    const lifetime = credentialLifetime(jwt({ sub: 'sam@example.com', exp: NOW / 1000 + 3600 }));
    expect(lifetime.expiresAtMs).toBe(NOW + 3_600_000);
    expect(lifetime.unknownReason).toBe('');
  });

  it('reports an opaque token as unknown rather than as expired', () => {
    // A personal access token is not a JWT and states nothing. Treating that as
    // an expiry of zero would refuse every benchmark in a workspace that issues
    // them.
    const lifetime = credentialLifetime('dapi0123456789abcdef');
    expect(lifetime.expiresAtMs).toBeNull();
    expect(lifetime.unknownReason).toContain('opaque');
  });

  it('reports a JWT with no exp claim as unknown', () => {
    const lifetime = credentialLifetime(jwt({ sub: 'sam@example.com' }));
    expect(lifetime.expiresAtMs).toBeNull();
    expect(lifetime.unknownReason).toContain('exp');
  });

  it('reports the absence of a token as unknown, which is the laptop case', () => {
    expect(credentialLifetime('').expiresAtMs).toBeNull();
  });
});

describe('deciding whether a credential can cover a suite', () => {
  const budget = 20 * 60_000;

  it('covers a suite when the credential outlasts the budget and the skew', () => {
    const lifetime = { expiresAtMs: NOW + budget + CLOCK_SKEW_MS, unknownReason: '' };
    const decided = coverage(lifetime, NOW, budget);
    expect(decided.covered).toBe(true);
  });

  it('refuses a credential that expires inside the budget', () => {
    const decided = coverage({ expiresAtMs: NOW + 5 * 60_000, unknownReason: '' }, NOW, budget);
    if (decided.covered) throw new Error('expected a refusal');
    expect(decided.code).toBe('IDENTITY_REQUIRED');
    // What the person can do, in the message, without naming a principal.
    expect(decided.message).toContain('Sign in again');
    expect(decided.message).not.toContain('service principal');
  });

  it('refuses a credential that only just covers the budget, because the clocks disagree', () => {
    // A container running behind the issuer would over-estimate what is left,
    // and the cost of being wrong is a suite that dies in its last case.
    const decided = coverage({ expiresAtMs: NOW + budget + 1_000, unknownReason: '' }, NOW, budget);
    expect(decided.covered).toBe(false);
  });

  it('lets an unreadable lifetime through, and says the run was not checked', () => {
    const decided = coverage({ expiresAtMs: null, unknownReason: 'the token is opaque' }, NOW, budget);
    if (!decided.covered) throw new Error('expected this to be allowed');
    // The note is the whole value of this branch: a run that stops later has to
    // be explicable from its own record.
    expect(decided.note).toContain('not checked');
    expect(decided.note).toContain('the token is opaque');
  });
});

describe('which refusals end a suite', () => {
  it('ends the suite on a failure of the run’s own identity', () => {
    // Every remaining case would be refused identically, so continuing spends
    // minutes to learn nothing.
    expect(endsTheSuite('IDENTITY_REQUIRED')).toBe(true);
    expect(endsTheSuite('IDENTITY_MISMATCH')).toBe(true);
    expect(endsTheSuite('USER_AUTH_REJECTED')).toBe(true);
  });

  it('does not end the suite when one question needed data the reader cannot see', () => {
    // The expected outcome of a benchmark run by a person rather than by an
    // application, and the next case still means something.
    expect(endsTheSuite('USER_NOT_AUTHORIZED')).toBe(false);
  });

  it('does not end the suite for failures that are not about identity at all', () => {
    expect(endsTheSuite('DEPENDENCY_UNAVAILABLE')).toBe(false);
    expect(endsTheSuite('RUN_DEADLINE_EXCEEDED')).toBe(false);
  });
});
