import { describe, expect, it } from 'vitest';

import { UNDETERMINED } from '../../shared/stated-cause';
import { scopeRefusalDiagnosis } from './scope-refusal';

/**
 * Which scope problem a 403 was, held against the two lists that decide it.
 *
 * The verdict needs BOTH: what the app asks for, and what the sign-in presented.
 * With only the first, a reader who held the scope was told their sign-in did not
 * carry it and sent to a private window that mints the same permission and meets
 * the same refusal. With only the second, a scope the app never declared reads as
 * a stale sign-in and the reader is handed work no sign-in can do.
 *
 * So these are mostly tests about which input moves the answer. The declared list
 * and the held-scope fact are varied one at a time, and nothing else in the call
 * changes between them.
 */
describe('which scope problem a refusal was', () => {
  /** The five the live deployment declares, including both Vector Search ones. */
  const DECLARED = [
    'sql',
    'dashboards.genie',
    'catalog.tables:read',
    'vectorsearch.vector-search-indexes:read',
    'vectorsearch.vector-search-endpoints:read',
  ];

  /** One refusal, so only the scope facts differ between the cases below. */
  const refusal = {
    declarable: 'catalog.tables:read',
    namedByWorkspace: 'unity-catalog',
    declared: DECLARED,
  };

  it('reads a scope the sign-in carries as a missing grant, and offers no sign-in', () => {
    const diagnosis = scopeRefusalDiagnosis({
      ...refusal,
      tokenScopes: ['unity-catalog', 'sql'],
      scopeHeld: true,
    });

    expect(diagnosis.cause).toBe('workspace-refused-a-held-scope');
    // The caller attaches the statement, because the object and the principal
    // are the probe's to name. What this module owes is the verdict.
    expect(diagnosis.grantIsMissing).toBe(true);
    expect(diagnosis.remedy).toBeNull();
    expect(diagnosis.explanation).toMatch(/carries `catalog\.tables:read`/);
    expect(diagnosis.explanation).toMatch(/leaves a grant on the object/i);
    // The sentence this branch exists to stop.
    expect(diagnosis.explanation).not.toMatch(/does not carry/i);
    // Both vocabularies, since a reader searching for either has to find it.
    expect(diagnosis.explanation).toMatch(/`unity-catalog`/);
  });

  it('reads a scope the sign-in demonstrably lacks as a stale sign-in', () => {
    const diagnosis = scopeRefusalDiagnosis({
      ...refusal,
      tokenScopes: ['sql'],
      scopeHeld: false,
    });

    expect(diagnosis.cause).toBe('token-lacks-declared-scope');
    expect(diagnosis.grantIsMissing).toBe(false);
    expect(diagnosis.remedy?.kind).toBe('ui');
    expect(diagnosis.remedy?.statement).toMatch(/private browsing window/i);
    // A grant is the wrong answer here and saying so is the point of the branch.
    expect(diagnosis.explanation).toMatch(/not a grant you are missing/i);
  });

  /**
   * The third value, and the reason the fact is three-valued rather than a
   * boolean. A token that enumerated nothing, or enumerated in a spelling this
   * deployment has not been taught, rules nothing out. The private window still
   * helps and is still offered; the prose may not claim the sign-in is short.
   */
  it('names both candidates when nothing was read about the sign-in', () => {
    const diagnosis = scopeRefusalDiagnosis({
      ...refusal,
      tokenScopes: null,
      scopeHeld: null,
    });

    expect(diagnosis.cause).toBe('declared-scope-refused');
    expect(diagnosis.grantIsMissing).toBe(false);
    expect(diagnosis.remedy?.kind).toBe('ui');
    expect(diagnosis.explanation).toMatch(/was not established/i);
    expect(diagnosis.explanation).toMatch(/grant you are missing/i);
    expect(diagnosis.explanation).not.toMatch(/Your sign-in to this app does not carry/);
  });

  /**
   * A HELD SCOPE DOES NOT OUTRANK AN UNDECLARED ONE. The two facts answer
   * different questions, and this is the case where believing the token over the
   * declaration would be wrong: whatever the token carries, an app that does not
   * ask for the permission hands out no sign-in that can, and the fix is a bundle
   * edit and a restart by whoever deploys it.
   */
  it('keeps a scope the app never asked for with whoever deploys the app', () => {
    for (const scopeHeld of [true, false, null] as const) {
      const diagnosis = scopeRefusalDiagnosis({
        declarable: 'vectorsearch.vector-search-indexes:read',
        namedByWorkspace: 'vector-search',
        declared: ['sql', 'catalog.tables:read'],
        tokenScopes: ['sql'],
        scopeHeld,
      });

      expect(diagnosis.cause).toBe('app-declares-no-such-scope');
      expect(diagnosis.grantIsMissing).toBe(false);
      expect(diagnosis.remedy?.kind).toBe('cli');
      expect(diagnosis.remedy?.run_by).toMatch(/whoever deploys this app/i);
    }
  });

  /**
   * The branch with the least evidence keeps the least to say. A deployment that
   * was not told what it declares cannot tell a stale sign-in from an undeclared
   * scope, and the two remedies contradict each other, so a held scope is not
   * enough to promote this to a grant either: the refusal may still have been
   * about a permission this build cannot see the declaration for.
   */
  it('offers nothing when it was not told what the app declares, whatever the token said', () => {
    for (const scopeHeld of [true, false, null] as const) {
      const diagnosis = scopeRefusalDiagnosis({
        declarable: 'catalog.tables:read',
        namedByWorkspace: 'unity-catalog',
        declared: null,
        tokenScopes: ['sql'],
        scopeHeld,
      });

      expect(diagnosis.cause).toBe(UNDETERMINED);
      expect(diagnosis.remedy).toBeNull();
      expect(diagnosis.grantIsMissing).toBe(false);
    }
  });
});
