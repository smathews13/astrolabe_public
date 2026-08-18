/**
 * The opening sequence's clock and its one decision (`#19a`).
 *
 * `loading-suite.md`: "Runs once per session on app open, before the login gate.
 * ~10s, skippable with any click or key; `prefers-reduced-motion` skips straight
 * to the gate." The geometry is `OPENING_CONSTELLATION` in `constellation.ts`; the
 * keyframes are `astrolabe-animation.css`. What is here is the timing and the
 * predicate, apart from the component so both can be tested without a DOM.
 *
 * ONCE PER SESSION IS THE GATE'S LATCH, NOT A SECOND ONE. The two run on the same
 * clock by specification -- the sequence precedes the gate and the gate shows once
 * a session -- so a separate key for the sequence would be a second answer to the
 * same question, and the two would disagree the first time one write failed and
 * the other did not. `firstOpenAcknowledged()` is the latch; this module only says
 * what to do with the answer.
 */

/**
 * The whole sequence, in seconds, and the number every keyframe here is a
 * percentage of.
 *
 * The reference runs `ast-draw`, `ast-pop`, `ast-concept`, `ast-hold` and
 * `ast-gate-in` at `10s` on one canvas, which is what makes them one sequence
 * rather than five animations that happen to be playing: the wordmark's window,
 * the concepts' turns and the gate's rise are all positions in this number.
 */
export const OPENING_SECONDS = 10;

/**
 * When the gate rises, as the fraction `ast-gate-in` holds it back for.
 *
 * The keyframe is `0%,60% { opacity: 0; translateY(24px) }` then `68% { opacity:
 * 1; translateY(0) }`, so the card is invisible for the first 60% of the sequence
 * and takes 8% of it to arrive. Read off the keyframe rather than typed beside it:
 * `astrolabe-keyframes.test.ts` pins the keyframe to the design reference, and a
 * hardcoded 0.6 here would be a second copy of a number that file already owns.
 */
export const GATE_RISE_FRACTION = 0.6;

/** When the card is mounted, in milliseconds from the sequence's start. */
export function gateRiseMs(): number {
  return OPENING_SECONDS * GATE_RISE_FRACTION * 1000;
}

/**
 * How long the rise itself takes, in milliseconds.
 *
 * 60% to 68% of the sequence, which is 0.8s. The card carries `ast-gate-in` for
 * this long and then stops carrying it, which is the whole of why this constant
 * exists -- see `RISE_SETTLE_MS`.
 */
export const RISE_FRACTION = 0.08;

/**
 * How long the card keeps the rise class before it is taken away.
 *
 * THE KEYFRAME HAS A TAIL THE APP MUST NOT PLAY. `ast-gate-in` is copied verbatim
 * from the design reference, where it runs `infinite` on a demo loop, so it ends
 * `94% { opacity: 1 } 100% { opacity: 0 }` -- the card fading out so the loop can
 * start again. In the app the gate is the screen the reader is being asked to
 * read, and a login card that dissolves four seconds after arriving is not a
 * design decision anybody made.
 *
 * So the card runs the keyframe from its 60% mark (a negative delay of
 * `gateRiseMs`) and gives the class up once the rise has landed, with half the
 * rise again as margin against a frame the browser was late for. What is left is
 * a card with no animation on it at all, at its own opacity and offset, which is
 * where the keyframe's hold would have put it anyway.
 */
export const RISE_SETTLE_MS = OPENING_SECONDS * RISE_FRACTION * 1000 * 1.5;

/**
 * The rise, as the timing the card carries.
 *
 * A NEGATIVE DELAY, and it is the whole trick. `ast-gate-in` holds the card
 * invisible for the sequence's first 60% because in the reference the card is
 * present from the first frame of a demo loop. The app does not render it at all
 * until the rise -- an invisible dialog is still focusable and still read out, so a
 * reader on a keyboard would be moving through a login card nobody can see -- so
 * the animation has to begin already six seconds in. `animation-delay: -6s` starts
 * it there.
 *
 * Both numbers are derived rather than typed, so the card rises at the same moment
 * the sky reaches 60% of its own loop. Written here rather than in the stylesheet
 * because a duration is a property of a seating: the same keyframes run at 7s on
 * the splash panel and 5s on the working strip, and a duration in a class would be
 * one of the three being right.
 */
export function gateRiseStyle(): { animationDuration: string; animationDelay: string } {
  return { animationDuration: `${OPENING_SECONDS}s`, animationDelay: `-${gateRiseMs() / 1000}s` };
}

/**
 * The concept marks at the centre of the canvas, in pixels.
 *
 * `loading-suite.md`: "the four mark concepts cycle (rete, reticle, horizon,
 * d-pad; 96px, ~1.6s each, ast-concept)". Which four and in what order is
 * `FLICKER_ORDER`'s answer, not this file's -- the sequence and the loaders show
 * the same concepts in the same order, and it ends on the d-pad so both resolve
 * on the app's identity mark rather than on one of the three it was chosen from.
 */
export const CONCEPT_SIZE = 96;

/** Each concept's turn, in seconds. Four of them fill 6.4s of the ten. */
export const CONCEPT_HOLD_SECONDS = 1.6;

/**
 * The offset the first concept waits before taking the canvas.
 *
 * The reference's delays are 0.3 / 1.9 / 3.5 / 5.1, so the cycle starts three
 * tenths of a second in rather than on the first frame. It is not a rounding: the
 * constellation's first hop starts at 0 and the mark arriving on the same frame
 * as the first line reads as one event instead of two.
 */
export const CONCEPT_LEAD_SECONDS = 0.3;

/**
 * When one concept's turn begins, in seconds from the sequence's start.
 *
 * Rounded to the hundredth because the result is a CSS `animation-delay` and
 * binary floating point does not give 5.1 for three sixteen-tenths and a lead:
 * the unrounded expression is 5.100000000000001, which is legal and illegible.
 */
export function conceptDelay(at: number): number {
  return Math.round((CONCEPT_LEAD_SECONDS + at * CONCEPT_HOLD_SECONDS) * 100) / 100;
}

/**
 * Whether the reader has asked for less motion.
 *
 * Read here rather than left to a media query, because for this surface the media
 * query is the wrong tool: the sequence is a full-viewport navy canvas that
 * exists only to be animated, and freezing it would leave a reader who asked for
 * no motion looking at a still night sky with a login card on it for no reason
 * they could work out. `loading-suite.md` says to skip it, and skipping means not
 * mounting it.
 *
 * The try/catch is for the same reason `browserAcknowledgementStore` has one: a
 * renderer with no `window`, and a browser old enough to have no `matchMedia`,
 * both have to answer something rather than throw. They answer "no preference
 * recorded", which is the fail-open direction and the one that shows the sequence.
 */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Whether the sequence plays at all.
 *
 * Pure, and takes both facts as arguments, because these are the two conditions
 * the spec puts on it and a test should be able to state all four combinations
 * without a browser to arrange them in.
 */
export function showsOpeningSequence({
  acknowledged,
  reducedMotion,
}: {
  /** Whether this session has already been through the gate. */
  acknowledged: boolean;
  reducedMotion: boolean;
}): boolean {
  return !acknowledged && !reducedMotion;
}
