/**
 * The segmented time range: 24h, 7 days, 30 days, All time, Custom.
 *
 * One component, imported by Monitoring and by Ops, for the reason the Refresh
 * control is one component: two copies of a control drift, and the drift shows
 * up as two pages that look like they mean the same window and do not.
 *
 * The choice lives in the URL and this reads it from there on every render, so
 * there is no second copy of the range in component state. Pressing a segment is
 * a navigation, which is what makes the browser's back button work on it.
 *
 * Everything about WHICH ranges exist and WHAT window each covers is in
 * time-range.ts. This file is markup, ARIA and the custom-range inputs.
 */
import { useSearchParams } from 'react-router';
import {
  CUSTOM_FROM_PARAM,
  CUSTOM_TO_PARAM,
  RANGE_SEGMENTS,
  rangeFromParams,
  withRange,
  type RangeKey,
} from './time-range';

export interface TimeRangeControlProps {
  /**
   * Named on the control's accessible name, because two of these can be on
   * screen in one session and "Time range" alone does not say which page's.
   */
  page: string;
  className?: string;
}

/**
 * The dates a custom range is between, as `<input type="date">` values.
 *
 * Dates rather than timestamps: the window a person asks for is a run of days,
 * and asking somebody to type a time to get a day is a control that resists
 * being used. `rangeWindow` parses either.
 */
function customEnds(params: URLSearchParams): { from: string; to: string } {
  return { from: params.get(CUSTOM_FROM_PARAM) ?? '', to: params.get(CUSTOM_TO_PARAM) ?? '' };
}

export function TimeRangeControl({ page, className }: TimeRangeControlProps) {
  const [params, setParams] = useSearchParams();
  const active = rangeFromParams(params);
  const ends = customEnds(params);

  const choose = (key: RangeKey) => {
    // Pressing Custom keeps whatever ends are already in the URL, so somebody
    // who came back to the page by a link that carries them does not have to
    // type them again. With no ends, `rangeWindow` falls back to the default
    // window and reports that it did.
    const next = withRange(`?${params.toString()}`, key, key === 'custom' ? ends : undefined);

    // Pressing the segment that is already chosen changes nothing, so it must not
    // push a history entry either. There is no unselected state to toggle into --
    // this is a radio group and one range is always in force -- and navigating to
    // the URL already open would leave the reader's Back button undoing presses
    // that never did anything, which reads as a dead Back button rather than as
    // the range control they were using.
    if (next === (params.toString() ? `?${params.toString()}` : '')) return;
    setParams(new URLSearchParams(next), { replace: false });
  };

  const setEnd = (which: 'from' | 'to', value: string) => {
    const nextEnds = { ...ends, [which]: value };
    setParams(new URLSearchParams(withRange(`?${params.toString()}`, 'custom', nextEnds)), { replace: false });
  };

  return (<div className={className ? `time-range ${className}` : 'time-range'}>
      {/* A radio group rather than a row of buttons: exactly one is chosen at a
          time, and that is what `radiogroup` means to a screen reader. Buttons
          would each announce as an independent action and leave the reader to
          work out that pressing one un-presses another. */}
      <div className="time-range-segments" role="radiogroup" aria-label={`Time range for ${page}`}>
        {RANGE_SEGMENTS.map((segment) => (<button
            key={segment.key}
            type="button"
            role="radio"
            aria-checked={active === segment.key}
            className="time-range-segment"
            // The painted state and the announced state are one attribute read
            // twice rather than two attributes that can disagree: the active
            // fill in the stylesheet is selected on `[aria-checked='true']`.
            onClick={() => choose(segment.key)}
          >
            {segment.label}
          </button>
        ))}
      </div>
      {/* Drawn only when Custom is the choice. Absent rather than disabled, for
          the same reason the consumer navigation has no greyed entries: a
          control that cannot be used is a question about why not. */}
      {active === 'custom' ? (<div className="time-range-custom">
          <label className="time-range-custom-label">
            From
            <input type="date" value={ends.from} onChange={(event) => setEnd('from', event.target.value)} />
          </label>
          <label className="time-range-custom-label">
            To
            <input type="date" value={ends.to} onChange={(event) => setEnd('to', event.target.value)} />
          </label>
          {/* Said on the page rather than left to be inferred from figures that
              look like a week's. A window nobody asked for, unannounced, is the
              page answering a different question. */}
          {!ends.from || !ends.to ? (<p className="time-range-custom-note">
              Pick both dates. Until then these figures are over the last 7 days.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
