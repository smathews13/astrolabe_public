import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANGE,
  RANGE_PARAM,
  rangeFromParams,
  rangeWindow,
  withRange,
} from './time-range';

/**
 * Choosing All time, and getting back off it.
 *
 * The segment was reported missing from the live app. It was not missing from the
 * code: it is in `RANGE_SEGMENTS`, the shared control draws it with the other
 * four, and `time-range-style.test.tsx` asserts all five render. What was missing
 * were the rules below, which are the ones a reader actually depends on -- that
 * the choice survives a link, that it does not eat the filters beside it, and
 * that there is a way back off it.
 *
 * Pure functions and a `URLSearchParams`, so there is no browser here. That is
 * the whole reason the range lives in this module rather than in the component.
 */

/** The `get` slice `rangeFromParams` and `rangeWindow` read. */
const at = (search: string) => new URLSearchParams(search);

/** Midday, fixed, so the arithmetic is asserted rather than the clock. */
const NOON = Date.parse('2026-08-17T12:00:00.000Z');

describe('selecting All time', () => {
  it('puts the choice in the URL, so the link carries it', () => {
    const search = withRange('', 'all');

    expect(search).toBe(`?${RANGE_PARAM}=all`);
    expect(rangeFromParams(at(search))).toBe('all');
  });

  /**
   * The reason a range lives in the URL at all is that an admin who has narrowed
   * a view wants to send it. A range that dropped the filters beside it on the
   * way would send a different view than the one on screen.
   */
  it('leaves every other filter alone', () => {
    const search = withRange('?person=someone%40example.com&outcome=failed&q=net+bookings&open=42', 'all');
    const params = at(search);

    expect(params.get(RANGE_PARAM)).toBe('all');
    expect(params.get('person')).toBe('someone@example.com');
    expect(params.get('outcome')).toBe('failed');
    expect(params.get('q')).toBe('net bookings');
    expect(params.get('open')).toBe('42');
  });

  /** Every question ever asked: the epoch to now, and it says which window it is. */
  it('spans the whole store and names itself', () => {
    const window_ = rangeWindow(at(`?${RANGE_PARAM}=all`), NOON);

    expect(window_.from).toBe(new Date(0).toISOString());
    expect(window_.to).toBe(new Date(NOON).toISOString());
    expect(window_.label).toBe('all time');
    // Not a substituted window. A page over one of those has to say so, and this
    // is exactly the range somebody presses to check whether anything is recorded.
    expect(window_.customIncomplete).toBe(false);
  });

  /**
   * Arriving from Custom drops the two ends. A stale `from` and `to` sitting
   * beside `range=all` is a link that means one thing today and another the next
   * time somebody presses Custom.
   */
  it('drops the custom ends on the way in', () => {
    const params = at(withRange('?range=custom&from=2026-01-01&to=2026-02-01', 'all'));

    expect(params.get(RANGE_PARAM)).toBe('all');
    expect(params.get('from')).toBeNull();
    expect(params.get('to')).toBeNull();
  });
});

/**
 * Getting back off it, which is the half Sam went looking for and could not find.
 *
 * He read the segmented control as a filter chip, tried to unclick the active
 * segment, and nothing happened. That is a radio group behaving correctly: one
 * range is ALWAYS in force, there is no unselected state, and the way off All
 * time is to choose another range rather than to clear this one. So "clearing"
 * here means returning to the default, and the rule that matters is that doing
 * so leaves no trace of All time in the URL to come back and haunt the link.
 */
describe('clearing All time', () => {
  it('leaves no range in the URL when the default is chosen again', () => {
    const search = withRange(`?${RANGE_PARAM}=all`, DEFAULT_RANGE);

    // Absent, not `range=7d`. A first-visit link stays clean, and an absent
    // parameter already reads as the default.
    expect(search).toBe('');
    expect(rangeFromParams(at(search))).toBe(DEFAULT_RANGE);
  });

  it('keeps the other filters when the range goes back to the default', () => {
    const params = at(withRange(`?${RANGE_PARAM}=all&outcome=failed`, DEFAULT_RANGE));

    expect(params.get(RANGE_PARAM)).toBeNull();
    expect(params.get('outcome')).toBe('failed');
  });

  it('narrows to a fixed window from All time without leaving the old choice behind', () => {
    const params = at(withRange(`?${RANGE_PARAM}=all`, '24h'));

    expect(params.get(RANGE_PARAM)).toBe('24h');
    expect(params.getAll(RANGE_PARAM)).toHaveLength(1);
  });

  /**
   * There is always exactly one range, which is what makes "no range selected" a
   * state that cannot be reached rather than one the page has to render. A
   * hand-edited or truncated URL falls back to the default instead of to nothing.
   */
  it('has a range even when the URL asks for none or for nonsense', () => {
    for (const search of ['', '?', `?${RANGE_PARAM}=`, `?${RANGE_PARAM}=forever`, '?person=someone']) {
      expect(rangeFromParams(at(search))).toBe(DEFAULT_RANGE);
    }
  });

  /**
   * Pressing the chosen segment again is a no-op, and the control relies on that
   * to skip the navigation: re-pressing All time must produce the search string
   * the page is already on, or the reader's Back button fills with presses that
   * did nothing.
   */
  it('is idempotent, so re-pressing a segment has nothing to navigate to', () => {
    expect(withRange(`?${RANGE_PARAM}=all`, 'all')).toBe(`?${RANGE_PARAM}=all`);
    expect(withRange('?outcome=failed', DEFAULT_RANGE)).toBe('?outcome=failed');
  });
});
