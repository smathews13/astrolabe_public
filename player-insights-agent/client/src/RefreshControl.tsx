/**
 * The one control in this app that re-reads something, and the line that says
 * when it last did.
 *
 * There were four of these, written four times: the Connections header, the
 * Architecture header, the retry inside the Connections error alert, and the
 * retry on the unavailable panel. Because each was its own markup, each could be
 * corrected on its own -- and three of them were, at which point one header said
 * "Re-check" while the sentence beneath the other named "Run the checks" and a
 * button doing exactly the same work said "Try again". The drift was not a
 * mistake anybody made; it was the shape of the code.
 *
 * So the word, the icon, the pending state and the freshness line are decided
 * here and nowhere else. A page supplies the two things only it knows: whether a
 * read is in flight, and when the last one finished.
 */
import { RefreshCw } from 'lucide-react';
import { Button } from './ui';
import { checkedAgo } from './architecture';

/** The word, in one place. */
export const REFRESH_LABEL = 'Refresh';

/**
 * What it says while it is working.
 *
 * The word carries the state on its own, which is what makes the spinner
 * optional: with animation switched off, the label and the disabled attribute
 * still say a read is in flight.
 */
export const REFRESH_BUSY_LABEL = 'Refreshing\u2026';

/** What the freshness line says before anything has been read. */
export const NEVER_READ = 'Not read yet';

/** The same, for a surface whose timestamp is a check rather than a read. */
export const NEVER_CHECKED = 'Not checked yet';

/**
 * When these answers were taken, in the design's own words.
 *
 * Relative rather than a clock time, because the question a reader has is
 * whether what they are looking at is from this sitting -- and a timestamp makes
 * them work that out. Rounded by `checkedAgo`, which the Architecture tile
 * strip also calls, so the two cannot round the same instant differently.
 *
 * Never a fake time and never a blank: nothing read yet says so.
 *
 * `now` defaults here rather than in the component so the clock is not read
 * during a render, and so a test can assert a rounding instead of the time of
 * day it happened to run at.
 */
export function readAgo(checkedAt: string, now: number = Date.now()): string {
  if (!checkedAt) return NEVER_READ;
  const ago = checkedAgo(checkedAt, now);
  return ago === 'not yet' ? NEVER_READ : `Read ${ago}`;
}

/**
 * The same instant, said as a CHECK rather than as a read.
 *
 * TWO WORDINGS, ONE CLOCK, AND THAT IS THE WHOLE REASON THIS LIVES HERE. The Ops
 * health band carries the moment a set of live probes ran, which is not the
 * moment a table was read, and the design says "Checked" there for that reason.
 * The rounding, the never-yet case and both wordings are in this file so that a
 * page cannot round the same instant its own way -- which is exactly what
 * `refresh-control.test.tsx` holds, by asserting that nothing outside this module
 * calls `checkedAgo`. Reach for one of these instead of importing that.
 */
export function checkedAgoLine(checkedAt: string, now: number = Date.now()): string {
  if (!checkedAt) return NEVER_CHECKED;
  const ago = checkedAgo(checkedAt, now);
  return ago === 'not yet' ? NEVER_CHECKED : `Checked ${ago}`;
}

/**
 * The rounded age with nothing said around it, for a cell under its own heading.
 *
 * The Ops health table has a "Last check" column, so a cell repeating the word
 * would be the heading again on every row. Empty rather than "Not checked" where
 * there is no stamp: the row's Result column already says that in the pill, and
 * saying it twice on one line reads as two findings.
 */
export function ageAgo(at: string, now: number = Date.now()): string {
  if (!at) return '';
  const ago = checkedAgo(at, now);
  return ago === 'not yet' ? '' : ago;
}

export interface RefreshButtonProps {
  /** Whether a read is in flight. Disables the button and spins the icon. */
  busy?: boolean;
  onRefresh: () => void;
  className?: string;
}

/**
 * The button, for the places that have no room for the freshness line -- inside
 * an error alert, or on the unavailable panel, where the line above it has
 * already said what could not be read and when.
 *
 * Its accessible name is its own text, so it reads as "Refreshing…" while it is
 * working rather than as a name that has stopped being true. The icon is hidden
 * from the accessibility tree for the same reason: it would otherwise be a
 * second, wordless copy of the button.
 */
export function RefreshButton({ busy = false, onRefresh, className }: RefreshButtonProps) {
  return (<Button
      /*
       * FILLED BLUE, EVERYWHERE IT APPEARS. It was `outline`, which put the one
       * control on these pages that does anything in the quietest treatment the
       * app has, on headings whose only other content is a timestamp. The Ops
       * health block had already been specified as primary blue, so five surfaces
       * disagreed with the sixth and the sixth was the one that was right.
       *
       * This is the reason the control is a component: the change is made once
       * here and Connections, Architecture, Monitoring, Ops, the unavailable
       * panel and the access gate all follow. Do not restyle it per page.
       */
      variant="default"
      size="sm"
      className={className ? `refresh-button ${className}` : 'refresh-button'}
      onClick={onRefresh}
      // A second press cannot race the first. Both reads land on the same
      // state, and the later answer used to be able to arrive first.
      disabled={busy}
      aria-busy={busy || undefined}
    >
      <RefreshCw className={busy ? 'size-3.5 refresh-spin' : 'size-3.5'} aria-hidden="true" />
      {busy ? REFRESH_BUSY_LABEL : REFRESH_LABEL}
    </Button>
  );
}

export interface RefreshControlProps extends RefreshButtonProps {
  /** ISO stamp of the last read, or empty where nothing has been read. */
  checkedAt: string;
  /** Injectable so a test can assert a rounding rather than the clock. */
  now?: number;
}

/**
 * The pair: when it was last read, then the button.
 *
 * The freshness line is what makes an unchanged answer visibly a fresh one. On a
 * healthy deployment every verdict comes back identical, so without it the only
 * evidence a press did anything is that nothing changed -- which is
 * indistinguishable from a control wired to nothing, and is what this one was
 * taken for.
 *
 * The visible line is hidden from the accessibility tree and repeated in a live
 * region, rather than being one element that is both. A live region is announced
 * when it CHANGES, which is how the wait and its end get spoken; leaving the
 * visible copy in the tree as well would make a reader hear the same sentence
 * twice on the way past.
 */
export function RefreshControl({ busy = false, checkedAt, now, onRefresh, className }: RefreshControlProps) {
  const line = readAgo(checkedAt, now);
  return (<div className={className ? `refresh-control ${className}` : 'refresh-control'}>
      <p className="refresh-control-when" aria-hidden="true">
        {line}
      </p>
      <RefreshButton busy={busy} onRefresh={onRefresh} />
      <p className="sr-only" role="status" aria-live="polite">
        {busy ? REFRESH_BUSY_LABEL : line}
      </p>
    </div>
  );
}
