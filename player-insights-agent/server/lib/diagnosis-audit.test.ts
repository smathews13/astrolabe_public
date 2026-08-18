import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { auditAll, UNDETERMINED, type AuditedDiagnoses } from '../../shared/stated-cause';
import { scopeRefusalDiagnosis } from './scope-refusal';
import { sessionFreshness } from './session-freshness';
import { tokenRejection } from './token-rejection';

/**
 * THE REGISTER OF EVERY DIAGNOSIS THIS APP STATES TO A USER.
 *
 * ADD YOURS HERE. If you have written something that tells a reader why
 * something is the way it is, enumerate its branches below. The audit is cheap,
 * it needs no workspace, and it is the difference between "we agreed not to do
 * that" and something that fails on the commit that does it.
 *
 * What it enforces, in one sentence: a diagnosis the app shows a user must be
 * derived from evidence the app actually has, or be labelled as unknown. In
 * practice that is three rules, all in `shared/stated-cause.ts`:
 *
 *  1. A branch whose `cause` is UNDETERMINED must not have prose that asserts a
 *     cause, and must not carry a remedy. A remedy is a claim about a cause.
 *  2. A branch that names a cause must cite evidence, and the evidence must quote
 *     something that was read rather than restate the verdict.
 *  3. A remedy statement is ONE action. A second action hung off the first with
 *     a condition is refused, and so is the same escalation moved into the
 *     guidance: the next verdict is this app's to reach from evidence, and a
 *     reader working down a list is the shape that cost the afternoon.
 *  4. A remedy's guidance is ONE SHORT LINE or nothing. It holds what a reader
 *     needs in order to carry the statement out correctly, and `''` is the
 *     commonest correct value. This is the field that used to be `note` and used
 *     to hold the "Why this is the fix" paragraph.
 *  5. No em dashes in copy a reader reaches (DECISIONS.md D9).
 *
 * WHY, IN THE WORDS OF THE THING THAT HAPPENED. On 2026-08-16 the Connections
 * page showed twenty-odd Unity Catalog rows as HTTP 403 to a reader who could
 * query every one of those tables. The scope-versus-grant half of that panel was
 * real work: it quotes Databricks' own "required scopes" wording and returns
 * undetermined with no remedy where it cannot tell. Then a confident sentence
 * about WHY the scope was absent was appended, and a four-step remedy built on
 * it. Nothing in the code could know that why. Three of the four steps were
 * already done and verified working. Nothing on the screen distinguished the
 * earned half from the invented one, so the reader could not know which he was
 * reading, and he did the three steps again.
 *
 * NOT EVERY DIAGNOSIS IN THE APP IS HERE YET. `dependency-probes.ts` states
 * several. Its scope-refusal branch, which is the one that caused all of this,
 * is registered below as `scopeRefusalDiagnosis`; the remaining verdicts in
 * that module (a grant, a missing object, a malformed identifier, a timeout)
 * are still plain prose on a check and are not audited from here. That is a
 * gap, not a judgement: this list is meant to grow, and the cheapest moment to
 * add a producer is the commit that writes it.
 */
const REGISTERED: AuditedDiagnoses[] = [
  {
    producer: 'sessionFreshness',
    branches: {
      // Every branch of the function, reached through the function itself rather
      // than written out as literals here. A copy of the copy would pass this
      // audit while the real copy drifted.
      'no forwarded sign-in': sessionFreshness({ token: null, declared: ['sql'] }),
      'token lists no scopes': sessionFreshness({ token: tokenWithScopes(null), declared: ['sql'] }),
      'declared list unknown': sessionFreshness({ token: tokenWithScopes('sql'), declared: null }),
      current: sessionFreshness({ token: tokenWithScopes('sql'), declared: ['sql'] }),
      stale: sessionFreshness({
        token: tokenWithScopes('sql'),
        declared: ['sql', 'catalog.tables:read'],
      }),
    },
  },
  {
    // Registered on the commit that rewrote it, which is the point being made
    // above. This copy had lived in `access-verification.ts` since long before
    // the audit existed and was therefore outside it: the guard covered the
    // module written alongside it and left the older neighbour, saying the same
    // kind of thing about the same token, completely unchecked.
    producer: 'tokenRejection',
    branches: {
      expired: tokenRejection({
        age: { kind: 'expired', expiresAt: '2026-08-16T20:00:00.000Z', secondsAgo: 900 },
        apiMessage: 'Databricks answered HTTP 401 with no message body.',
      }),
      live: tokenRejection({
        age: { kind: 'live', expiresAt: '2026-08-16T23:00:00.000Z', secondsLeft: 2400 },
        apiMessage: 'Databricks answered HTTP 401 with no message body.',
      }),
      unreadable: tokenRejection({
        age: { kind: 'unreadable', why: 'the token states no expiry' },
      }),
    },
  },
  {
    // The producer this whole guard was written about. Every branch reached
    // through the function, so the audit sees the copy the Connections page
    // shows rather than a transcription of it that could drift away from it.
    producer: 'scopeRefusalDiagnosis',
    branches: {
      'the app declares it, the sign-in does not carry it': scopeRefusalDiagnosis({
        declarable: 'catalog.tables:read',
        namedByWorkspace: 'unity-catalog',
        declared: ['sql', 'catalog.tables:read'],
        tokenScopes: ['sql'],
        scopeHeld: false,
      }),
      'the sign-in carries it and the workspace refused anyway': scopeRefusalDiagnosis({
        declarable: 'catalog.tables:read',
        namedByWorkspace: 'unity-catalog',
        declared: ['sql', 'catalog.tables:read'],
        tokenScopes: ['sql', 'unity-catalog'],
        scopeHeld: true,
      }),
      'the app declares it and the sign-in did not say': scopeRefusalDiagnosis({
        declarable: 'catalog.tables:read',
        namedByWorkspace: 'unity-catalog',
        declared: ['sql', 'catalog.tables:read'],
        tokenScopes: null,
        scopeHeld: null,
      }),
      'the app never asked for it': scopeRefusalDiagnosis({
        declarable: 'vectorsearch.vector-search-indexes:read',
        namedByWorkspace: 'vector-search',
        declared: ['sql', 'catalog.tables:read'],
        tokenScopes: ['sql', 'unity-catalog'],
        scopeHeld: false,
      }),
      'the deployment was not told what it declares': scopeRefusalDiagnosis({
        declarable: 'catalog.tables:read',
        namedByWorkspace: 'unity-catalog',
        declared: null,
        tokenScopes: ['sql'],
        scopeHeld: false,
      }),
      'the sign-in did not list its permissions': scopeRefusalDiagnosis({
        declarable: 'catalog.tables:read',
        namedByWorkspace: '',
        declared: ['catalog.tables:read'],
        tokenScopes: null,
        scopeHeld: null,
      }),
    },
  },
];

function tokenWithScopes(scope: string | null): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ sub: 'reviewer@example.com', ...(scope === null ? {} : { scope }) }),
    'not-a-real-signature',
  ].join('.');
}

describe('every diagnosis this app states to a user', () => {
  /**
   * The findings are asserted as a list rather than as a count, because the list
   * IS the failure message: somebody who trips this needs to be told which
   * producer, which branch, and which sentence, not that something is amiss.
   */
  it('is derived from evidence the app has, or is labelled as unknown', () => {
    expect(auditAll(REGISTERED)).toEqual([]);
  });

  /**
   * The audit is only worth anything if a real regression trips it, so this pins
   * that it does, on the exact shape of the 2026-08-16 defect: an undetermined
   * verdict with a confident sentence and a remedy list bolted on.
   */
  it('would fail on the sentence and the remedy list that caused it', () => {
    const findings = auditAll([
      {
        producer: 'aRegression',
        branches: {
          'cannot tell': {
            cause: UNDETERMINED,
            evidence: '',
            explanation:
              'Databricks refused this call. This is because your browser is presenting a token that ' +
              'was minted before the app declared this scope.',
            remedy: {
              kind: 'cli',
              statement:
                '# 1. Add the scope to user_api_scopes.\n# 2. databricks apps stop\n' +
                '# 3. databricks apps start\n# 4. Sign out of Databricks and back in.',
              guidance: 'Consent covers the scope set that was in force when you last signed in.',
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([
      expect.stringContaining('the explanation a user reads asserts one'),
      expect.stringContaining('a remedy is offered'),
    ]);
  });

  /**
   * The 401 advice that stood in `access-verification.ts` until this commit,
   * quoted exactly, run through the audit it was never subject to.
   *
   * Two findings, and they are the two things it did to a reader. The evidence
   * is the verdict in longer words: it names three causes it had not read
   * anything to distinguish. And the statement is a list of three actions, in
   * which the reload only works on one of those causes and signing out of the
   * workspace works on none, because this app's sign-in is not the workspace's.
   */
  it('would fail on the reload advice that stood on the 401 path', () => {
    const findings = auditAll([
      {
        producer: 'theOldTokenRejectedCopy',
        branches: {
          401: {
            cause: 'token-rejected',
            evidence: 'The token is expired, revoked, or not valid for this workspace.',
            explanation:
              'Databricks refused your forwarded token itself (HTTP 401) before it considered any ' +
              'permission, so no statement was run and nothing about your own access was ' +
              'established.',
            remedy: {
              kind: 'ui',
              statement:
                'Reload this page to pick up a fresh token. If it persists, sign out of the\n' +
                'workspace and back in, then open the app again.',
              guidance: 'Databricks Apps mints the forwarded token and refreshes it with the session.',
            },
          },
        },
      },
    ]);
    expect(findings).toEqual([
      expect.stringContaining('quotes nothing that was read'),
      expect.stringContaining('hangs a second action off the first'),
    ]);
  });

  /** Every branch is registered, so a new one cannot be added and left unaudited. */
  it('covers every branch of both registered producers', () => {
    expect(Object.keys(REGISTERED[0].branches)).toHaveLength(5);
    expect(Object.keys(REGISTERED[1].branches)).toHaveLength(3);
  });
});

/**
 * THE HOLE THE REGISTER LEAVES, narrowed where it can be narrowed.
 *
 * The audit above only sees what somebody remembered to register, and the copy
 * it was written for was two files away from the copy that caused it, unaudited
 * for exactly that reason. Nothing here can close that in general. What it can
 * do is close it for the file the problem actually appeared in: a click-path
 * remedy written inline in `access-verification.ts` fails this, and the failure
 * points at the register.
 *
 * A click path rather than any remedy, because the distinction is real. A
 * `GRANT` or a CLI call is checkable by the person who runs it and fails
 * visibly if it is wrong. "Do this in your browser" cannot be checked by
 * anyone, is where every bad remedy in this app's history has been written,
 * and is the shape a reader cannot tell apart from a determination.
 */
describe('click-path advice on the access path', () => {
  const SOURCE = readFileSync(new URL('../routes/access-verification.ts', import.meta.url), 'utf8');

  it('is not written inline, so it cannot escape the register', () => {
    expect(SOURCE).not.toMatch(/kind:\s*'ui'/);
  });

  /**
   * The specific sentence, kept out by name. It survived several rewrites of
   * the surrounding file, because each rewrite read it as advice somebody else
   * had already thought about.
   */
  it('does not tell anybody to reload for a fresh token', () => {
    expect(SOURCE).not.toMatch(/reload (?:this|the) page (?:to|for)/i);
  });
});
