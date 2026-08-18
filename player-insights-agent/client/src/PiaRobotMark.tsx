/**
 * The agent's robot, drawn once, for the animation and for every mark that signs
 * an agent turn.
 *
 * The strip that runs while a question is in flight and the small mark beside a
 * finished answer are the same figure, so they come out of the same file. They
 * were not: the strip had this robot and the transcript had a lucide sparkle in a
 * filled orange chiclet, so the app introduced itself with one glyph and reported
 * with another, and whichever a reader saw second read as a different product.
 *
 * ONE definition, and that is the point of this file rather than a tidiness
 * preference. The geometry is the design's, to the half pixel, and a second copy
 * pasted into an avatar would be right on the day it was pasted and wrong after
 * the first retune -- silently, because the two are never on screen together for
 * anyone to compare. agent-mark.test.ts fails if this markup turns up in a second
 * source file.
 *
 * No colour is written here. The fills are classes, painted from tokens in
 * styles/animation.css next to the keyframes that move them, which is what stops
 * an avatar drawn in a second, slightly different orange -- and it is also why the
 * mark is still wherever it is not inside the animation: every `animation`
 * declaration those classes carry is scoped under `.pia-anim`, so an antenna does
 * not pulse and an eye does not blink in a card header. That holds before
 * `prefers-reduced-motion` is consulted at all; the media query in that file stops
 * the strip itself, which is the only thing here that was ever meant to move.
 */

/**
 * The design's grid. Every glyph in the working strip -- controller, store, robot
 * -- is drawn on the same 72-unit square, which is what makes three figures sized
 * from one CSS rule come out at the same scale as each other.
 */
const GRID_VIEW_BOX = '0 0 72 72';

/**
 * The same drawing, windowed onto itself, for the marks whose box IS the mark.
 *
 * The robot occupies x 8-64 and y 8-52 of the grid above: it is centred across
 * the grid but sits high in it, because the grid leaves room below for a
 * controller's body rather than for this. Rendered through the full 72-square at
 * avatar size that empty band becomes real, and the mark lands a couple of pixels
 * above the middle of its own box while drawing smaller than the space it was
 * given -- which is what the sparkle it replaces used to look like, and the
 * complaint that started this.
 *
 * So the window is a 64-unit square centred on the artwork's own centre, (36, 30):
 * x from 4 to 68, y from -2 to 62. The negative edge is margin, not a crop --
 * nothing is drawn above y=8 -- and it is what puts four units of clearance on
 * every side, so the ears cannot touch an edge and nothing is clipped at any size.
 * A square window against a square box also means the scale is uniform, so the
 * robot cannot arrive squashed. agent-mark.test.ts derives all of this from the
 * shapes below rather than trusting the string.
 */
const MARK_VIEW_BOX = '4 -2 64 64';

export function PiaRobotMark({ fit = 'mark', className }: { fit?: 'grid' | 'mark'; className?: string }) {
  return (
    <svg
      className={className ? `pia-robot ${className}` : 'pia-robot'}
      viewBox={fit === 'grid' ? GRID_VIEW_BOX : MARK_VIEW_BOX}
      focusable="false"
      /* Decorative in all four of its seatings. What names the turn is the copy
         beside it -- the takeaway, the badge, the "Final answer" eyebrow -- so a
         screen reader announcing "image" here would be reading out the fact that
         a picture exists and nothing about the answer it sits on. */
      aria-hidden="true"
    >
      <rect className="pia-antenna" x="33" y="8" width="6" height="8" rx="2" />
      <rect className="pia-robot-head" x="16" y="16" width="40" height="36" rx="8" />
      <rect className="pia-robot-head" x="8" y="26" width="6" height="14" rx="3" />
      <rect className="pia-robot-head" x="58" y="26" width="6" height="14" rx="3" />
      <g className="pia-eyes">
        <rect className="pia-cutout" x="24" y="26" width="8" height="10" rx="2" />
        <rect className="pia-cutout" x="40" y="26" width="8" height="10" rx="2" />
      </g>
      <rect className="pia-cutout" x="26" y="42" width="20" height="4" rx="2" />
    </svg>
  );
}
