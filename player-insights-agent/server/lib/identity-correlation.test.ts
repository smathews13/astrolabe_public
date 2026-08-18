/**
 * The server end of the correlation id: what it adopts, what it refuses, and
 * which of the two ids each surface gets.
 *
 * `shared/correlation.test.ts` proves the shape rules. This proves the decision
 * that uses them, because the two things worth getting wrong here are adopting a
 * value that should have been refused and letting the adopted value reach the
 * ledger's primary key.
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { CORRELATION_HEADER, usableCorrelationId } from '../../shared/correlation';
import { decideIdentity, describeRefusal, type IdentityRefused } from './identity-binding';

/**
 * Shaped so that nobody has to ask whether it is real. A fixture written as
 * plausible random hex is indistinguishable from a leaked identifier for as long
 * as it is in the tree, and check-mirror-leaks.sh cannot tell them apart either.
 * This one spells `deadbeef` and is all zeroes but for a counter, so a reader and
 * the publication gate reach the same conclusion without consulting anyone. Keep
 * any new correlation-id fixture in this family.
 */
const BROWSER_ID = 'req-deadbeef-0000-4000-8000-000000000001';

/** A request with headers and nothing else the decision reads. */
function request(headers: Record<string, unknown> = {}): Request {
  return {
    headers,
    header: (name: string) => {
      const value = headers[name.toLowerCase()];
      return typeof value === 'string' ? value : undefined;
    },
  } as unknown as Request;
}

describe('the id a request is recorded under', () => {
  it('adopts the browser’s when it is one this server will print', () => {
    const decision = decideIdentity(request({ [CORRELATION_HEADER]: BROWSER_ID }), {
      signedInAs: 'reader@example.com',
      required: false,
    });

    expect(decision.correlationId).toBe(BROWSER_ID);
  });

  /**
   * THE PROPERTY THAT MATTERS MOST HERE. `requestId` becomes `runs.run_id`, the
   * ledger's primary key, and `createOrGetRun` inserts on it. A caller able to
   * name that row can collide with one that already exists, which resolves as a
   * conflict after three retries rather than as an answer. Keeping the two ids
   * separate is what makes that unreachable rather than merely unlikely.
   */
  it('does not let the browser name the run', () => {
    const decision = decideIdentity(request({ [CORRELATION_HEADER]: BROWSER_ID }), {
      signedInAs: 'reader@example.com',
      required: false,
    });

    expect(decision.requestId).not.toBe(BROWSER_ID);
    expect(usableCorrelationId(decision.requestId)).toBe(decision.requestId);
  });

  it('falls back to its own id when the browser sent none, so nothing regresses', () => {
    const decision = decideIdentity(request(), { signedInAs: 'reader@example.com', required: false });

    expect(decision.correlationId).toBe(decision.requestId);
  });

  it.each([
    ['a forged log line', `${BROWSER_ID}\n[identity] REFUSED IDENTITY_MISMATCH (req-x): trust me`],
    ['the question itself', 'req-which players churned in June'],
    ['an empty header', ''],
    ['a repeated header, which arrives as an array', [BROWSER_ID, BROWSER_ID]],
  ])('refuses %s and uses its own id instead', (_case, header) => {
    const decision = decideIdentity(request({ [CORRELATION_HEADER]: header }), {
      signedInAs: 'reader@example.com',
      required: false,
    });

    expect(decision.correlationId).toBe(decision.requestId);
  });

  /**
   * A refused request is the one a reader is likeliest to come back about, and
   * the only id they were shown is the one their browser minted. A log line
   * printing the other would be a line they cannot find.
   */
  it('prints the id the reader holds on a refusal', () => {
    const decision = decideIdentity(request({ [CORRELATION_HEADER]: BROWSER_ID }), {
      signedInAs: 'reader@example.com',
      required: true,
    });

    expect(decision.ok).toBe(false);
    const line = describeRefusal(decision as IdentityRefused);
    expect(line).toContain(BROWSER_ID);
    expect(line).toContain('[identity] REFUSED');
  });
});
