/**
 * Why the Monitoring list refuses to be paged, and why that refusal is code
 * rather than a comment.
 *
 * THE LATENT FAULT. The questions statement takes its page with
 * `ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`, and `created_at` is not
 * unique. Two questions asked in the same instant have NO defined order between
 * them, and Postgres is free to return them in a different order on the second
 * read than the first. A caller walking the range in pages of 100 can therefore
 * be shown a row twice and never be shown another one at all -- and the pages
 * look perfectly ordinary either way, because nothing on them is out of
 * sequence. Only the row that vanished says anything is wrong, and it says it by
 * being absent.
 *
 * NOTHING PAGES TODAY, so nobody is affected. The offset is a parameter the
 * rewrite added while making the cost of this route a function of the page. That
 * is exactly the shape of thing somebody adopts innocently later, on the
 * reasonable assumption that a paging parameter pages, and a comment saying
 * otherwise would not stop them: comments stop nobody.
 *
 * The sort is NOT being changed to fix it. Adding `u.id` to the order is the
 * correct fix and it is a change to the one clause that makes this statement
 * fast, with no Postgres here to measure the consequence against. So the option
 * is refused instead, out loud, in a sentence that says what would have to
 * change first.
 *
 * The last test below couples the two, so the guard cannot outlive its reason:
 * make the order total and it asserts the refusal is gone.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MONITORING_QUESTIONS_QUERY,
  QUESTION_READ_LIMIT,
  pageFrom,
  setupMonitoringRoutes,
} from './monitoring-routes';
import type { InsightsAppKit } from './insights-routes';
import type { Application, Request, Response } from 'express';

function asked(query: Record<string, string>): Request {
  return { query, headers: {}, params: {}, header: () => undefined, get: () => undefined } as unknown as Request;
}

/** The list route, over a store that answers with nothing. */
function questionsRoute(path = '/api/monitoring/questions') {
  let handler: ((req: Request, res: Response) => Promise<void>) | null = null;
  const app = {
    get: (registered: string, fn: (req: Request, res: Response) => Promise<void>) => {
      if (registered === path) handler = fn;
    },
  } as unknown as Application;

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  setupMonitoringRoutes(
    {
      lakebase: { query: () => Promise.resolve({ rows: [] }) },
      server: { extend: (fn: (target: Application) => void) => fn(app) },
    } as unknown as InsightsAppKit,
    { isAdminRoute: () => true, probeFor: () => null }
  );
  log.mockRestore();
  return handler as unknown as (req: Request, res: Response) => Promise<void>;
}

async function answerTo(path: string, query: Record<string, string>) {
  const handler = questionsRoute(path);
  let code = 200;
  let body: Record<string, unknown> = {};
  const res = {
    json: (payload: Record<string, unknown>) => {
      body = payload;
    },
    status: (given: number) => {
      code = given;
      return res;
    },
    setHeader: () => res,
  } as unknown as Response;
  await handler(asked({ ...query, email: 'someone@example.test' }), res);
  return { code, body };
}

describe('the offset the questions list will not accept', () => {
  it('refuses a page that starts part way in, and says why', () => {
    const page = pageFrom(asked({ offset: '100' }));

    expect(page.refusal).not.toBe('');
    // Named for the caller, not for the schema: what they lose is a row, and
    // the reason is that two questions can share an instant.
    expect(page.refusal.toLowerCase()).toContain('skip');
    expect(page.refusal).toContain(String(QUESTION_READ_LIMIT));
  });

  it('answers the request with that sentence rather than with a page', async () => {
    const refused = await answerTo('/api/monitoring/questions', { offset: '100' });

    expect(refused.code).toBe(400);
    expect(String(refused.body.error)).toContain('skip');
  });

  it('refuses it on the per-person list too, which reads the same statement', async () => {
    const refused = await answerTo('/api/monitoring/people/:email', { offset: '100' });

    expect(refused.code).toBe(400);
  });

  /**
   * A garbled offset is not an attempt to page. `?offset=` from a form that
   * submitted an empty field must not turn a working list into a 400.
   */
  it('reads a missing, empty or unparseable offset as no offset at all', () => {
    const queries: Record<string, string>[] = [
      {},
      { offset: '' },
      { offset: '0' },
      { offset: 'later' },
      { offset: '-5' },
    ];
    for (const query of queries) {
      expect(pageFrom(asked(query)).refusal).toBe('');
      expect(pageFrom(asked(query)).offset).toBe(0);
    }
  });

  /**
   * And the limit still works, because a single page has nothing to skip
   * BETWEEN: the tie only decides which of two same-instant rows sits on the
   * boundary, and the response already declares itself truncated.
   */
  it('still takes a smaller page, which is the safe half of this', () => {
    expect(pageFrom(asked({ limit: '50' }))).toEqual({ limit: 50, offset: 0, refusal: '' });
    expect(pageFrom(asked({ limit: '999999' })).limit).toBe(QUESTION_READ_LIMIT);
  });
});

describe('the guard and the sort it exists for', () => {
  /**
   * THE COUPLING, so neither half can move without the other.
   *
   * The refusal is not a policy about paging, it is a consequence of an order
   * that is not total. Give the page's `ORDER BY` a unique tie-break and this
   * test starts demanding the refusal be withdrawn; withdraw the refusal
   * without the tie-break and it fails the other way. Either half alone is a
   * bug, and the failure names which one was done.
   */
  it('refuses offsets exactly while the page order is not total', () => {
    const pageClause = MONITORING_QUESTIONS_QUERY.slice(
      MONITORING_QUESTIONS_QUERY.indexOf('WITH page AS'),
      MONITORING_QUESTIONS_QUERY.indexOf('range_totals AS')
    );
    const order = /ORDER BY([^\n]*)/.exec(pageClause)?.[1] ?? '';
    // `id` is the table's primary key, so an order carrying it is total and the
    // same offset returns the same rows every time.
    const total = /\bu\.id\b/.test(order);

    if (total) {
      expect(
        pageFrom(asked({ offset: '100' })).refusal,
        'The page order now has a unique tie-break, so offsets are safe: withdraw the refusal in pageFrom.'
      ).toBe('');
    } else {
      expect(
        pageFrom(asked({ offset: '100' })).refusal,
        'The page order is still not total, so an offset can skip a row: pageFrom must refuse it.'
      ).not.toBe('');
    }
  });
});
