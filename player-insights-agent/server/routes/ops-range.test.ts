/**
 * That the window the Ops server reads is the window the reader picked.
 *
 * THIS TEST EXISTS BECAUSE THREE OF THE FOUR RANGE OPTIONS DID NOT WORK AND
 * EVERY TEST PASSED. Picking 24h or 30 days returned the last 7 days. The button
 * highlighted, every caption still read "in this range", and the page printed no
 * dates, so there was nothing on screen to check a figure against: a cost total
 * for the wrong week was indistinguishable from one for the right week.
 *
 * The cause was a seam rather than a calculation. The control writes its choice
 * to the URL as a WORD -- `range=24h` -- and deliberately writes no timestamps
 * for the three fixed options. The server reads `from` and `to` and has never
 * read `range`. Ops handed the browser's own search string straight to the three
 * routes, so for those options the server received no bounds at all and fell back
 * to its default of the last seven complete days. `7d` was right by coincidence:
 * it is that same default.
 *
 * SO IT IS DELIBERATELY TESTED ACROSS THE SEAM, and that is why a server test
 * imports two client modules. Everything on both sides of this bug was correct in
 * isolation and had tests proving it: `rangeWindow` returned the right window for
 * every key, `opsRange` parsed the right bounds from the right parameters, and
 * nothing anywhere asserted that the second was given what the first produced.
 * A test of either half would still pass today with the bug restored.
 *
 * The chain below is the real one, in order:
 *
 *   1. `withRange` -- what the control writes to the URL when a segment is pressed.
 *   2. `rangeWindow` -- what the page resolves that to before fetching.
 *   3. the query string the page sends.
 *   4. `opsRange` -- what the server makes of it.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

import { rangeWindow, withRange, RANGE_SEGMENTS, type RangeKey } from '../../client/src/time-range';
import { opsRange } from './ops-routes';

/** A Wednesday, so no assertion below depends on a week boundary. */
const NOW = Date.parse('2026-03-18T15:40:00.000Z');
const DAY_MS = 86_400_000;

/** The last complete day, which is the only day any Ops range can end on. */
const LAST_COMPLETE = '2026-03-17';

/**
 * Express's parsed query, from a search string.
 *
 * `opsRange` reads `req.query`, and building it here rather than mocking the
 * function keeps the parameter NAMES in the test. The bug was a mismatch of
 * names -- `range` sent, `from` and `to` read -- and a test that passed bounds in
 * by hand would agree with the server about the names and prove nothing.
 */
function requestFor(search: string): Request {
  const params = new URLSearchParams(search);
  return { query: Object.fromEntries(params) } as unknown as Request;
}

/**
 * The whole chain for one option, exactly as the page performs it.
 *
 * `custom` is what the reader typed into the two date fields, which the control
 * puts in the URL alongside `range=custom`.
 */
function windowFor(key: RangeKey, custom?: { from: string; to: string }) {
  // 1. The control writes the choice to the URL.
  const search = withRange('', key, custom);
  // 2. The page resolves it to two instants.
  const resolved = rangeWindow(new URLSearchParams(search), NOW);
  // 3. The page sends those, and only those.
  const sent = `?from=${encodeURIComponent(resolved.from)}&to=${encodeURIComponent(resolved.to)}`;
  // 4. The server reads them.
  return { urlSearch: search, sent, range: opsRange(requestFor(sent), NOW) };
}

/** Whole days from one `YYYY-MM-DD` to another, counting both ends. */
function daysCovered(range: { from: string; to: string }): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS) + 1;
}

describe('the range the Ops server is asked for', () => {
  /**
   * The four assertions the bug would have failed. 24h and 30d both returned
   * seven days; only the count distinguishes them, so the count is asserted
   * rather than the label.
   */
  const expected: Record<RangeKey, { days: number; from: string }> = {
    // One complete day. "Last 24 hours" cannot include today, because a range
    // ending today would draw a partial day beside complete ones.
    '24h': { days: 1, from: '2026-03-17' },
    '7d': { days: 7, from: '2026-03-11' },
    '30d': { days: 30, from: '2026-02-16' },
    // All time starts at the epoch, which is what proves the choice survived the
    // chain: an unbounded window that came back as seven days is the exact
    // regression this file exists for, and it is the one option whose bug would
    // look most like success. 20530 days from 1970-01-01 to the last complete day.
    all: { days: 20530, from: '1970-01-01' },
    // The reader's own two dates, clamped to the last complete day at the far end.
    custom: { days: 5, from: '2026-03-02' },
  };

  for (const segment of RANGE_SEGMENTS) {
    it(`is the window "${segment.label}" means, and not the default`, () => {
      const custom =
        segment.key === 'custom' ? { from: '2026-03-02T00:00:00.000Z', to: '2026-03-06T00:00:00.000Z' } : undefined;
      const { range } = windowFor(segment.key, custom);
      expect(range.from).toBe(expected[segment.key].from);
      expect(daysCovered(range)).toBe(expected[segment.key].days);
    });
  }

  /**
   * The specific shape of the regression, asserted on its own so that a future
   * reader can see what went wrong rather than inferring it from four counts.
   *
   * Every fixed option must reach the server as a DIFFERENT window. They were
   * all the same one.
   */
  it('gives 24h, 7 days and 30 days three different windows', () => {
    const windows = (['24h', '7d', '30d'] as const).map((key) => JSON.stringify(windowFor(key).range));
    expect(new Set(windows).size).toBe(3);
  });

  /**
   * And the reason it was invisible: the control's word never reaches the server,
   * so a server that reads only `range` would see nothing and a page that sends
   * only `range` gets the default. Asserted from the URL the control writes,
   * which is the artefact that made the two disagree.
   */
  it('sends timestamps rather than the control\u2019s word', () => {
    const { urlSearch, sent } = windowFor('30d');
    // What the control put in the browser's URL.
    expect(urlSearch).toContain('range=30d');
    // What the page asks the server for. The word is not in it.
    expect(sent).not.toContain('range');
    expect(sent).toContain('from=');
    expect(sent).toContain('to=');
  });

  /**
   * The bug itself, reproduced, so this file proves what it claims.
   *
   * The old wiring is one line: hand the browser's search string to the route
   * instead of the resolved window. Kept as an assertion rather than a comment
   * because "this used to be broken" is worth being able to run, and because it
   * shows the failure was total rather than an off-by-one: 24h and 30 days came
   * back as the same seven days as each other.
   */
  it('would return the default for every option if the URL were forwarded raw', () => {
    const raw = (key: RangeKey) => opsRange(requestFor(withRange('', key)), NOW);
    for (const key of ['24h', '30d'] as const) {
      expect(daysCovered(raw(key))).toBe(7);
      expect(raw(key)).toEqual(raw('7d'));
    }
  });

  /** Every option ends on the last complete day. Billing rows arrive late. */
  it('never runs a range up to today', () => {
    for (const segment of RANGE_SEGMENTS) {
      const custom =
        segment.key === 'custom'
          ? // Deliberately asks for today, which must be clamped off the end.
            { from: '2026-03-02T00:00:00.000Z', to: '2026-03-18T00:00:00.000Z' }
          : undefined;
      expect(windowFor(segment.key, custom).range.to).toBe(LAST_COMPLETE);
    }
  });
});

describe('the Custom option, checked for the same class of defect', () => {
  it('uses both dates the reader typed', () => {
    const { range } = windowFor('custom', {
      from: '2026-02-10T00:00:00.000Z',
      to: '2026-02-20T00:00:00.000Z',
    });
    expect(range).toEqual({ from: '2026-02-10', to: '2026-02-20' });
  });

  /**
   * Reversed ends are a typed mistake and not an empty range, and an empty range
   * renders as "nothing in this range", which sends somebody looking for a data
   * problem that is a date.
   */
  it('reads a backwards range forwards rather than as nothing', () => {
    const { range } = windowFor('custom', {
      from: '2026-02-20T00:00:00.000Z',
      to: '2026-02-10T00:00:00.000Z',
    });
    expect(range).toEqual({ from: '2026-02-10', to: '2026-02-20' });
  });

  /**
   * A half-filled custom range falls back to the default window, which is
   * correct, and the page has to SAY it fell back. `customIncomplete` is the flag
   * it says it with, and the failure this guards is the silent one: figures over
   * the default window under a highlighted Custom button, with nothing anywhere
   * admitting the substitution.
   */
  it('flags an incomplete custom range instead of substituting a window quietly', () => {
    const search = withRange('', 'custom', { from: '2026-02-10T00:00:00.000Z', to: '' });
    const resolved = rangeWindow(new URLSearchParams(search), NOW);
    expect(resolved.customIncomplete).toBe(true);

    // And what it falls back to is the default, not an open interval.
    const sent = `?from=${encodeURIComponent(resolved.from)}&to=${encodeURIComponent(resolved.to)}`;
    expect(daysCovered(opsRange(requestFor(sent), NOW))).toBe(7);
  });

  it('drops a stale from and to when the reader moves off Custom', () => {
    // A link carrying custom ends, then 24h pressed. Leaving the ends in the URL
    // would make the same link mean one thing today and another tomorrow.
    const search = withRange('?range=custom&from=2026-02-10&to=2026-02-20', '24h');
    expect(search).not.toContain('from=');
    expect(search).not.toContain('to=');
    expect(daysCovered(windowFor('24h').range)).toBe(1);
  });
});
