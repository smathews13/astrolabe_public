/**
 * How old the content in the semantic index is, and whether that is a problem.
 *
 * WHY THIS EXISTS, in one paragraph, because the reason is the specification.
 * The nightly job that rebuilds the semantic layer failed every night from 11
 * to 15 August. The index went on answering every probe for five days while
 * serving vocabulary written on the 10th -- including a title that no longer
 * exists in the tables -- and nothing anywhere said so, because every surface
 * that watched the index only ever asked whether it answers. Reachability was
 * never the question. An index that is behind answers faster than one that is
 * being rebuilt.
 *
 * SO THE AGE IS THE READING, and it comes from the index itself: the Vector
 * Search payload reports the source commit its last sync processed, the probe
 * carries it as `content_at`, and both this and the Connections row are drawn
 * from that one value. Nothing here computes a timestamp, and nothing here
 * substitutes one -- see {@link contentAge} for what happens when the workspace
 * reports none, which is that the card says so.
 *
 * IT IS A SECOND PILL RATHER THAN A STATUS. An index serving month-old
 * vocabulary is not unreachable; it answers perfectly, and grading it `Blocked`
 * would say something false about the thing the status word means everywhere
 * else on the page. What is wrong is its content, which is the same shape of
 * fault the card already draws as a quiet second pill for drift: the connection
 * is fine and what it is connected to is not what anyone intended.
 */

/**
 * How often the content is supposed to be rebuilt.
 *
 * DERIVED FROM THE BUNDLE RATHER THAN CHOSEN HERE.
 * `var.semantic_rebuild_schedule` in
 * resources/player_insights_semantic.vector_index.yml is {@link REBUILD_CRON},
 * which is 07:00 UTC daily, and semantic-freshness-schedule.test.ts reads that
 * file and fails if the cron and this number stop agreeing. Relax the cron and
 * the test tells you this has to move with it, which is the only thing keeping
 * a threshold in the client honest about a schedule in the bundle.
 */
export const REBUILD_INTERVAL_HOURS = 24;

/** The cron this interval is read from. Kept as the string so the test can compare it. */
export const REBUILD_CRON = '0 0 7 * * ?';

/**
 * How many rebuilds have to be missed before the content is called stale.
 *
 * TWO, AND THE REASON IS ARITHMETIC RATHER THAN TASTE. Content is at its oldest
 * in the minutes before a rebuild runs, so at one interval the card would cry
 * stale every night about an index behaving exactly as designed, and a warning
 * that is wrong daily is a warning nobody reads by the end of the week. Past
 * two intervals no such reading is possible: a scheduled run has not landed. So
 * the first age this fires on is also the first age that is genuinely a fault,
 * and the outage it is built to catch is caught on its second morning.
 */
export const STALE_AFTER_REBUILDS = 2;

/** The age at which content stops being explicable by the schedule. */
export const STALE_AFTER_HOURS = REBUILD_INTERVAL_HOURS * STALE_AFTER_REBUILDS;

/** The three things that can be known about the age of the content. */
export type ContentAgeState =
  /** Nothing reported a time. Unknown, and never to be drawn as current. */
  | 'unreported'
  /** Young enough to be explained by the rebuild schedule. */
  | 'fresh'
  /** Older than the schedule can explain, so a rebuild did not land. */
  | 'stale';

export interface ContentAge {
  state: ContentAgeState;
  /** The words on the pill. Short: it sits beside the status pill. */
  label: string;
  /** The sentence behind them, for the detail and the text equivalent. */
  note: string;
  /** Whole hours since the content was written, or null when nothing said. */
  hours: number | null;
}

/** The pill's words when nothing reported a time. Asserted against in the tests. */
export const CONTENT_AGE_UNREPORTED_LABEL = 'Age not reported';

export const CONTENT_AGE_UNREPORTED_NOTE =
  'Nothing reported when this index last took content from its source, so the age of what it ' +
  'serves is unknown rather than current. An index answers just as readily when it is behind.';

/** The pill's words when a time came back that cannot be an age. */
export const CONTENT_AGE_UNUSABLE_LABEL = 'Age not usable';

export const CONTENT_AGE_UNUSABLE_NOTE =
  'The time reported for this content is in the future, which no age can be computed from. That ' +
  'is a disagreement between two clocks rather than a fresh index, and it is reported as unknown ' +
  'for the same reason a missing time is.';

/**
 * The age as a span, floored to the coarsest unit that is still true.
 *
 * Floored rather than rounded because this number is read as an accusation: "2
 * d old" for something 47 hours old is a claim that can be checked against the
 * timestamp and found exact, where "2 d" for 36 hours cannot.
 */
function span(hours: number): string {
  if (hours < 1) return 'under 1 h';
  if (hours < REBUILD_INTERVAL_HOURS) return `${hours} h`;
  return `${Math.floor(hours / REBUILD_INTERVAL_HOURS)} d`;
}

/**
 * What to say about content last written at `iso`, as of `now`.
 *
 * `iso` is the probe's `content_at` and nothing else. An empty string, an
 * unparseable one, or one in the future all come back `unreported`: the last is
 * there because a clock that disagrees with the workspace's would otherwise
 * produce a negative age, and a negative age rendered as freshness is the
 * cheerful version of the bug this whole module exists to prevent.
 */
export function contentAge(iso: string | undefined, now: number): ContentAge {
  const at = iso ? new Date(iso).getTime() : Number.NaN;
  if (Number.isNaN(at)) {
    return {
      state: 'unreported',
      label: CONTENT_AGE_UNREPORTED_LABEL,
      note: CONTENT_AGE_UNREPORTED_NOTE,
      hours: null,
    };
  }
  if (at > now) {
    return {
      state: 'unreported',
      label: CONTENT_AGE_UNUSABLE_LABEL,
      note: CONTENT_AGE_UNUSABLE_NOTE,
      hours: null,
    };
  }
  const hours = Math.floor((now - at) / 3_600_000);
  if (hours < STALE_AFTER_HOURS) {
    return {
      state: 'fresh',
      label: `Rebuilt ${span(hours)} ago`,
      note:
        `This index last took content from its source ${span(hours)} ago. The rebuild runs every ` +
        `${REBUILD_INTERVAL_HOURS} h, so that is within the schedule.`,
      hours,
    };
  }
  return {
    state: 'stale',
    label: `Stale \u00b7 ${span(hours)} old`,
    note:
      `This index is still serving content it took from its source ${span(hours)} ago. The rebuild ` +
      `runs every ${REBUILD_INTERVAL_HOURS} h, so a run has not landed and it is searching ` +
      'vocabulary the tables may no longer match. It answers either way, which is why nothing ' +
      'else on this page would tell you.',
    hours,
  };
}
