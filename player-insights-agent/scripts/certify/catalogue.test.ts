import { describe, expect, it } from 'vitest';
import {
  acceptsAttestation,
  CHECKS,
  checkDefinition,
  REQUIRED_CODES,
  statusWithoutProbe,
  unobservableCodes,
} from './catalogue.ts';

describe('the catalogue', () => {
  it('has no duplicate codes, since a result is matched to a definition by code', () => {
    const codes = CHECKS.map((check) => check.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('names the reason for every check no API can answer', () => {
    // The point of the rule: a check cannot be downgraded to unverifiable by
    // quietly changing one field. Saying why is the price of the downgrade.
    const silent = CHECKS.filter((check) => check.observability !== 'api' && !check.notObservable);
    expect(silent.map((check) => check.code)).toEqual([]);
  });

  it('does not explain away a check that an API does answer', () => {
    const overexplained = CHECKS.filter((check) => check.observability === 'api' && check.notObservable);
    expect(overexplained.map((check) => check.code)).toEqual([]);
  });

  it('gives every check a remedy, because a finding with no next step gets ignored', () => {
    expect(CHECKS.filter((check) => !check.remedy.trim())).toEqual([]);
  });

  it('uses codes that are stable, shouted identifiers rather than prose', () => {
    for (const check of CHECKS) expect(check.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

describe('acceptsAttestation', () => {
  it('admits a statement only where nothing can observe the thing', () => {
    expect(acceptsAttestation('OAUTH_SCOPE_CONSENT_PROVEN')).toBe(true);
    expect(acceptsAttestation('CLIENT_RENDERS_UNAVAILABLE')).toBe(true);
  });

  it('refuses a statement about something an API answers', () => {
    expect(acceptsAttestation('OAUTH_SCOPES_IN_EFFECT')).toBe(false);
    expect(acceptsAttestation('LAKEBASE_STORAGE_READABLE')).toBe(false);
  });

  it('refuses a statement about a check that is merely unbuilt', () => {
    // A probe that has not been written is work, not an unanswerable question.
    // Letting it be attested would remove the pressure to write it.
    expect(acceptsAttestation('SIGNED_USER_ASK_CANARY')).toBe(false);
  });

  it('refuses a code the catalogue does not have', () => {
    expect(acceptsAttestation('MADE_UP')).toBe(false);
  });
});

describe('statusWithoutProbe', () => {
  it('is unverifiable where no observation exists', () => {
    expect(statusWithoutProbe('OAUTH_SCOPE_CONSENT_PROVEN')).toBe('unverifiable');
    expect(statusWithoutProbe('CLIENT_RENDERS_UNAVAILABLE')).toBe('unverifiable');
  });

  it('is unknown where the probe is simply not written yet', () => {
    expect(statusWithoutProbe('SIGNED_USER_ASK_CANARY')).toBe('unknown');
    expect(statusWithoutProbe('DENIED_USER_NO_FALLBACK')).toBe('unknown');
  });

  it('is unknown for an unrecognised code rather than throwing', () => {
    expect(statusWithoutProbe('MADE_UP')).toBe('unknown');
  });
});

describe('what the catalogue admits it cannot see', () => {
  it('lists the scope consent check, which is the lesson this repository paid for', () => {
    expect(unobservableCodes()).toContain('OAUTH_SCOPE_CONSENT_PROVEN');
  });

  it('says in the scope consent check that the effective list is not proof', () => {
    const definition = checkDefinition('OAUTH_SCOPE_CONSENT_PROVEN');
    expect(definition?.notObservable).toContain('effective_user_api_scopes is not proof');
  });

  it('keeps the required set non-empty, or the gate certifies nothing', () => {
    expect(REQUIRED_CODES.length).toBeGreaterThan(5);
  });
});
