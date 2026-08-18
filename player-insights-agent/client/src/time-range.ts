/**
 * The time range Monitoring and Ops are both read over, and the URL it lives in.
 *
 * ONE MODULE FOR BOTH PAGES, and that is the whole reason it exists. Monitoring
 * reads a question list and a summary strip; Ops reads health, cost and traffic.
 * Every one of those is a figure over a window, and a page whose strip is over
 * one window and whose list is over another is a page that quietly disagrees
 * with itself. Section 5.8 of the plan forbids exactly that, so the range is
 * derived here and nowhere else.
 *
 * WHY THE URL IS THE STORE. An admin who has narrowed Ops to the last 24 hours
 * has done work, and the point of that work is usually to send it to somebody.
 * A range held in component state cannot be sent, cannot be reloaded, and is
 * lost by the browser's back button.
 *
 * `TimeRangeControl.tsx` renders this. Nothing about appearance is decided here,
 * so every rule below can be tested without a browser.
 */

/** The parameter holding the choice. */
export const RANGE_PARAM = 'range';

/** The two ends of a custom range, as ISO timestamps or dates. */
export const CUSTOM_FROM_PARAM = 'from';
export const CUSTOM_TO_PARAM = 'to';

export type RangeKey = '24h' | '7d' | '30d' | 'all' | 'custom';

/** Seven days, matching Genie's weekly digest, which Monitoring is modelled on. */
export const DEFAULT_RANGE: RangeKey = '7d';

/**
 * The segments, in the order they are drawn, with the word on each.
 *
 * A list rather than five literals in the component, so the control, the tests
 * and anything that later needs to name a range read one set of words. The
 * labels are the design's: "24h" abbreviated, the others spelled out.
 *
 * All time sits after the three fixed windows and before Custom, because the
 * first four widen in order and Custom is the escape from that sequence rather
 * than the end of it. A reader scanning left to right reads one progression.
 */
export const RANGE_SEGMENTS: readonly { key: RangeKey; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

const RANGE_KEYS = new Set<string>(RANGE_SEGMENTS.map((segment) => segment.key));

/** The slice of `URLSearchParams` this reads, so a test needs no browser. */
export interface ReadableParams {
  get(name: string): string | null;
}

/**
 * The selected range, defaulting to seven days.
 *
 * An unrecognised value falls back to the default rather than to nothing, so a
 * hand-edited or truncated URL still renders a page.
 */
export function rangeFromParams(params: ReadableParams): RangeKey {
  const raw = (params.get(RANGE_PARAM) ?? '').trim();
  return RANGE_KEYS.has(raw) ? (raw as RangeKey) : DEFAULT_RANGE;
}

export interface RangeWindow {
  /** ISO timestamp of the start of the window. */
  from: string;
  /** ISO timestamp of the end. */
  to: string;
  /** The words a caption uses, so two panels over one window say one thing. */
  label: string;
  /**
   * Whether a custom range was asked for and could not be used.
   *
   * True means the window below is the default rather than what the URL asked
   * for, and a page showing figures over it has to say so. A silently
   * substituted window is a page answering a question nobody put.
   */
  customIncomplete: boolean;
}

const DAY_MS = 86_400_000;

const SEVEN_DAYS = 'last 7 days';

/**
 * The start of all time, which is a real timestamp rather than an absent bound.
 *
 * The reads this feeds acme ends and bound on both. Sending an empty `from`
 * would have every caller decide separately what an open interval means, and the
 * epoch is earlier than any row a Postgres `timestamptz` column in this store can
 * hold, so it selects everything without any of them having to.
 */
const START_OF_TIME = new Date(0).toISOString();

/**
 * The two timestamps to query, from the word in the URL.
 *
 * `now` is a parameter rather than a call to `Date.now()` so a test can assert
 * the arithmetic instead of the clock, and so a strip and a list rendered in one
 * pass cannot land either side of a midnight.
 *
 * A custom range missing or misspelling either end falls back to the default
 * window rather than querying an open interval, and says that it did.
 */
export function rangeWindow(params: ReadableParams, now: number): RangeWindow {
  const key = rangeFromParams(params);
  const to = new Date(now).toISOString();
  const fallback = { from: new Date(now - 7 * DAY_MS).toISOString(), to, label: SEVEN_DAYS };
  if (key === 'custom') {
    const from = (params.get(CUSTOM_FROM_PARAM) ?? '').trim();
    const until = (params.get(CUSTOM_TO_PARAM) ?? '').trim();
    if (!isTimestamp(from) || !isTimestamp(until)) return { ...fallback, customIncomplete: true };
    const start = new Date(from);
    const end = new Date(until);
    // Reversed ends are a typed mistake rather than an empty range, and an empty
    // range renders as "no questions in this range", which sends somebody
    // looking for a data problem that is a date.
    if (start.getTime() > end.getTime()) {
      return { from: end.toISOString(), to: start.toISOString(), label: 'the selected range', customIncomplete: false };
    }
    return { from: start.toISOString(), to: end.toISOString(), label: 'the selected range', customIncomplete: false };
  }
  if (key === '24h') {
    return { from: new Date(now - DAY_MS).toISOString(), to, label: 'last 24 hours', customIncomplete: false };
  }
  if (key === '30d') {
    return { from: new Date(now - 30 * DAY_MS).toISOString(), to, label: 'last 30 days', customIncomplete: false };
  }
  if (key === 'all') {
    return { from: START_OF_TIME, to, label: 'all time', customIncomplete: false };
  }
  return { ...fallback, customIncomplete: false };
}

function isTimestamp(value: string): boolean {
  return value !== '' && Number.isFinite(Date.parse(value));
}

/**
 * The search string after choosing a range, with everything else left alone.
 *
 * Every parameter this does not recognise is preserved, which is what keeps a
 * filter, an open drawer and anything a later tab adds intact through a range
 * change. Leaving the default range out of the URL keeps a first-visit link
 * clean, and `rangeFromParams` reads an absent parameter as the default, so the
 * two agree.
 *
 * Moving OFF custom drops the two custom ends rather than leaving them in the
 * URL. A stale `from` and `to` beside `range=24h` is a link that means one thing
 * today and another the next time somebody presses Custom.
 */
export function withRange(search: string, key: RangeKey, custom?: { from: string; to: string }): string {
  const params = new URLSearchParams(search);
  if (key === DEFAULT_RANGE) params.delete(RANGE_PARAM);
  else params.set(RANGE_PARAM, key);
  if (key === 'custom') {
    if (custom?.from) params.set(CUSTOM_FROM_PARAM, custom.from);
    if (custom?.to) params.set(CUSTOM_TO_PARAM, custom.to);
  } else {
    params.delete(CUSTOM_FROM_PARAM);
    params.delete(CUSTOM_TO_PARAM);
  }
  const next = params.toString();
  return next ? `?${next}` : '';
}
