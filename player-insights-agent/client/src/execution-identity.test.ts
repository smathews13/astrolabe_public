import { describe, expect, it } from 'vitest';
import { isOpaqueId, principalLabel, withoutRepeatedPrincipal } from './execution-identity';

/**
 * How a principal is named, and how the gate's verification detail is repeated.
 *
 * This file was written for a status strip that stood above every page, and most
 * of it tested that strip's copy. The strip is gone, and those tests went with
 * it. Two rules outlived it, because they were never really about the banner:
 *
 *   NEVER PRINT A FULL IDENTIFIER. The uuid appears at most once on a screen,
 *   and a label in a row is not that place: the label abbreviates, the
 *   Connections page records.
 *
 *   DO NOT SPEAK FOR THE EXECUTION LAYER. Which identity actually runs a
 *   question is decided per release, server-side, and reported on the
 *   Connections page from what the server said.
 *
 * The second is worth keeping the history of, because it is the reversal of a
 * rule this repo held for less than a day. The banner's verified line used to be
 * REQUIRED to state that the service principal was still executing, on the
 * reasoning that "your access was verified" standing alone reads as though the
 * reader's own identity is running the queries. Then on-behalf-of execution
 * shipped and that safeguard became the false claim it was built to prevent: a
 * constant compiled into the client is wrong on exactly the release that changes
 * the arrangement it describes. The rule inverted, and the assertions below hold
 * the surviving sentence — the server's verification detail — to it.
 */

/**
 * A fabricated uuid, not this deployment's. The assertions below are about the
 * SHAPE of what may be printed, so naming the real serving principal here bought
 * nothing and put the app's service principal id in a tracked file that the
 * customer can read.
 */
const SERVING = '00000000-0000-4000-8000-000000000000';

describe('the abbreviated principal', () => {
  it('never returns a full uuid', () => {
    const label = principalLabel(SERVING);
    expect(label).not.toContain(SERVING);
    expect(label).toBe('00000000\u2026');
    // Long enough to tell two principals apart, short enough not to be the
    // first thing read on every screen.
    expect(label.length).toBeLessThan(12);
  });

  it('shows a name whole, because a name is worth reading', () => {
    expect(principalLabel('player-insights-serving-sp')).toBe('player-insights-serving-sp');
  });

  it('truncates a name too long for a status row', () => {
    const label = principalLabel('an-extremely-long-service-principal-display-name');
    expect(label).toHaveLength(28);
    expect(label.endsWith('\u2026')).toBe(true);
  });

  it('returns nothing for nothing, rather than a placeholder identity', () => {
    // A stored placeholder in a governance record looks like an identity, which
    // is the failure this app is most careful about.
    for (const empty of [null, undefined, '', '   ']) {
      expect(principalLabel(empty)).toBe('');
    }
  });

  it('knows an opaque id from a name, so a settings row can say which it is', () => {
    expect(isOpaqueId(SERVING)).toBe(true);
    expect(isOpaqueId('player-insights-serving-sp')).toBe(false);
    expect(isOpaqueId(null)).toBe(false);
  });
});

/**
 * The paragraph that used to sit under the banner and now sits on the
 * Connections page, beside the principal it names.
 *
 * Verbatim from the server except for abbreviating a repeated principal id when
 * one appears. The verification summary no longer claims who executes — that
 * is the Questions / analyticalExecution line — so the fixture matches what
 * was verified, not an execution identity.
 */
describe('the verification detail, moved into settings', () => {
  const DETAIL =
    'Verified you hold CAN_USE on the SQL warehouse and SELECT on 10 tables under your own token. ' +
    'CAN RUN confirmed on 2 of 2 Genie spaces under the same token. Row-level filters and column ' +
    'masks were not checked and are not covered by this.';

  it('leaves a summary that names no principal untouched', () => {
    expect(withoutRepeatedPrincipal(DETAIL, SERVING)).toBe(DETAIL);
  });

  it('abbreviates a principal id when the detail still names one', () => {
    const withId = `${DETAIL} Compared with ${SERVING}.`;
    const shown = withoutRepeatedPrincipal(withId, SERVING);
    expect(shown).not.toContain(SERVING);
    expect(shown).toContain('00000000\u2026');
    expect(shown).toContain('CAN_USE on the SQL warehouse and SELECT on 10 tables');
  });

  /**
   * The honest limit of what was checked. Keeping the grants and dropping this
   * would turn a partial check into a clean bill of health, which is the exact
   * overstatement the access gate exists to prevent.
   */
  it('keeps the row-filter and column-mask caveat', () => {
    expect(withoutRepeatedPrincipal(DETAIL, SERVING)).toContain(
      'Row-level filters and column masks were not checked and are not covered by this.'
    );
  });

  it('does not claim who executes asks', () => {
    const shown = withoutRepeatedPrincipal(DETAIL, SERVING);
    expect(shown).not.toMatch(/\bruns? as you\b/i);
    expect(shown).not.toMatch(/\bexecutes? as you\b/i);
    expect(shown).not.toMatch(/execution still runs as/i);
  });

  it('matches the id whatever case it arrives in', () => {
    // The id and the sentence reach the client by different code paths. A rule
    // that quietly matches nothing is worse than no rule, and this repo has
    // shipped two of those.
    const shouty = `Checked beside ${SERVING.toUpperCase()}.`;
    expect(withoutRepeatedPrincipal(shouty, SERVING)).not.toContain(SERVING.toUpperCase());
  });

  it('leaves the sentence untouched when there is no principal to abbreviate', () => {
    const noPrincipal =
      'Verified you hold CAN_USE on the SQL warehouse under your own token. Genie space access was not checked as you.';
    expect(withoutRepeatedPrincipal(noPrincipal, null)).toBe(noPrincipal);
    expect(withoutRepeatedPrincipal(noPrincipal, '  ')).toBe(noPrincipal);
    expect(withoutRepeatedPrincipal('', SERVING)).toBe('');
  });
});
