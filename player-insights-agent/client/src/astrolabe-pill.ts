/**
 * The one status recipe, named once, for every surface that carries a state word.
 *
 * `astrolabe-tokens.css` declares `.ast-pill` and its five families. This module
 * is the other half: the join between what a thing MEANS on a page and which
 * family says so. It exists because the recipe was previously twenty-one
 * independently-written base rules -- `.status-badge`, `.ops-pill`,
 * `.monitoring-pill`, `.bench-pill`, `.arch-node-status` and the rest -- which
 * agreed on nothing. They disagreed on radius (4px, 6px and 999px), on label
 * size (10px through 12px), on whether there was a border at all, and on which
 * green: DuBois `#277C43` in some, astrolabe `#35706B` in others, on the same
 * screen.
 *
 * Converging them in the STYLESHEET alone would not have held. A surface that
 * needs a sixth state writes a sixth rule beside its own five, and the next
 * person reads five local rules as the local convention. Converging them here
 * means a surface cannot name a colour at all: it names a meaning, and the
 * meaning has one rendering.
 *
 * ## Never colour alone
 *
 * Every one of these returns a class list and nothing else. The ELEMENT has to
 * carry a word, and no rule here can check that, so it is a per-surface test:
 * `ops-render`, `monitoring-render`, `connections-render` and
 * `architecture-render` each assert that the pills they draw have text in them.
 *
 * ## Which family a state takes
 *
 * The mapping is deliberately narrow, and the two easy mistakes are both about
 * red:
 *
 * - **Nothing was established** is never red. A dependency nobody probed, a
 *   figure nobody could read, a refusal: none of these is a fault, and painting
 *   them red sends somebody to investigate a service that is fine. They are
 *   `neutral-outline`, or `warn` where something happened but settled nothing.
 * - **A qualification is not a failure.** "Experimental", "Estimate" and
 *   "Drift" say how much weight a number will bear. They are `warn`.
 */

/**
 * The five families the palette declares, plus the outlined form of neutral.
 *
 * Written as meanings rather than as colours, so a call site cannot say "green"
 * about a state that is not positive.
 */
export type AstPillFamily = 'pos' | 'neg' | 'warn' | 'neutral' | 'neutral-outline' | 'info';

/**
 * The class list for one pill.
 *
 * @param family which of the five the state belongs to
 * @param extra a surface's own layout class, where it needs one. Layout only:
 *   nowrap on a one-word pill, wrapping on a pill carrying a sentence. Nothing
 *   passed here may set a colour, a border or a radius.
 */
export function astPill(family: AstPillFamily, extra?: string): string {
  return ['ast-pill', `ast-pill--${family}`, extra].filter(Boolean).join(' ');
}

/**
 * A value that IS its own verdict: an identifier set in mono inside a status
 * chip, per the rebuild spec §2's "value badges".
 *
 * Separate from {@link astPill} because the mono face is not optional here and
 * is not wanted on a word pill. `plain` is not a sixth family: it is the absence
 * of a claim, for a value nothing has checked, and it deliberately gets no chip
 * at all rather than a grey one, which would read as a verdict of its own.
 */
export function astValueBadge(family: AstPillFamily | 'plain', extra?: string): string {
  if (family === 'plain') return ['ast-num', extra].filter(Boolean).join(' ');
  return ['ast-pill', `ast-pill--${family}`, 'ast-num', extra].filter(Boolean).join(' ');
}
