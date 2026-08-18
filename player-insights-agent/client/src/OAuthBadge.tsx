/**
 * The badge in the header that says whether the sign-in is working.
 *
 * MARKUP ONLY. Which state is in play, and every word of it, is oauth-badge.ts's
 * -- and the sentence in the tooltip is the SERVER's, carried through that
 * module untouched. This file reads no identity, fetches nothing and decides
 * nothing, for the same reason RoleBadge does not: a second opinion formed here
 * is a second answer to a question one place is supposed to answer.
 *
 * It is a chip and not a pill, which is the visual difference from the role
 * badge sitting immediately to its right. The role badge is a 999px pill with no
 * border because it is a label for who somebody is. This is the app's status
 * badge -- 1px edge, 4px radius, wash fill, coloured text -- the same treatment
 * the Connections page gives a dependency that answered or refused, because that
 * is what this is: a thing that was checked, reported next to its result.
 */
import { Check, Minus, X } from 'lucide-react';
import {
  OAUTH_BADGE_WORD,
  oauthBadgeAccessibleName,
  oauthBadgeLabel,
  oauthBadgeState,
  oauthBadgeTitle,
  type OAuthBadgeIdentity,
} from './oauth-badge';

/** The mark for each drawn state. Absent while resolving, which draws nothing. */
const MARKS = {
  working: Check,
  'not-working': X,
  // A dash rather than a question mark: unknown here is "not established",
  // which is a blank rather than a query put to the reader.
  unknown: Minus,
  resolving: null,
} as const;

/** Every mark is a lucide glyph at this size, so all three states are one width. */
const MARK_SIZE = 11;

/**
 * Which of `.ast-pill`'s families each state wears.
 *
 * §2 allows the app one status chip, so the fill, the edge and the ink all come
 * from the shared recipe now rather than from three rules of this badge's own
 * against the retired db- washes. Unknown takes the neutral FILL rather than the
 * outline: the header is white and the Connections card is white, so there is no
 * tint underneath for a fill to muddy, and a filled chip is what this state has
 * always been.
 *
 * Resolving has none, deliberately. It is not a state of the sign-in, it is the
 * absence of one, and any of the five would be a fourth thing the badge appears
 * to be reporting. shell.css gives it a plain band grey and nothing else.
 */
const FAMILIES = {
  working: 'ast-pill--pos',
  'not-working': 'ast-pill--neg',
  unknown: 'ast-pill--neutral',
  resolving: '',
} as const;

export function OAuthBadge({ identity }: { identity: OAuthBadgeIdentity | null | undefined }) {
  const state = oauthBadgeState(identity);
  const label = oauthBadgeLabel(state);
  const title = oauthBadgeTitle(identity);
  const accessibleName = oauthBadgeAccessibleName(state);
  const Mark = MARKS[state];

  return (
    /*
      `data-oauth-state` rather than a class per state, so shell.css selects on it
      and a test can read which of the four is drawn without parsing a class list.
      That is the role badge's convention and this sits beside it.

      Titled and named only when there is something to say. While the identity
      read is in flight the chip holds its width so the cluster does not jump
      when the answer lands, and `aria-hidden` says it is exactly that: a
      `title=""` flashes an empty tooltip and an `aria-label=""` is an element
      announced with no name, which is worse than an unnamed one.
    */
    <span
      className={`ast-pill oauth-badge ${FAMILIES[state]}`.trim()}
      data-oauth-state={state}
      data-testid="oauth-badge"
      aria-busy={state === 'resolving' || undefined}
      aria-hidden={state === 'resolving' || undefined}
      {...(title ? { title } : {})}
      {...(accessibleName ? { 'aria-label': accessibleName } : {})}
    >
      {state === 'resolving' ? (
        /*
         * THE SPACE IS RESERVED BY THE CONTENT, NOT BY A NUMBER.
         *
         * This box used to be `width: 62px; height: 22px`, measured once against
         * the drawn states and correct only while nothing about them moved. It
         * stopped being correct the moment the badge took the app's 11px pill
         * recipe instead of its own 12px chip, and re-measuring it would have
         * needed a browser to measure in.
         *
         * A mark and the word, in the same box, at the same size, made invisible.
         * `visibility: hidden` keeps the box in the layout and takes its contents
         * out of the paint and out of the accessibility tree both, so the chip is
         * exactly as wide as whatever replaces it -- and stays exactly as wide
         * after a change of font, of type scale, or of the word itself. There is
         * no number here to go stale.
         *
         * Any of the three marks would do: all three are lucide glyphs at
         * MARK_SIZE, so they occupy one box. The word is imported rather than
         * typed, because a placeholder that stopped matching what it holds room
         * for would be a shift nobody could see coming.
         */
        <span className="oauth-badge-reserve">
          <Check size={MARK_SIZE} strokeWidth={3} />
          {OAUTH_BADGE_WORD}
        </span>
      ) : (
        <>
          {/* Hidden from assistive technology because the badge already carries
              its whole meaning as a name. The mark is how a reader who is looking
              tells the three apart at a glance -- colour alone would be the only
              signal for anybody who cannot separate the green from the red. */}
          {Mark ? <Mark size={MARK_SIZE} strokeWidth={3} aria-hidden="true" /> : null}
          {label}
        </>
      )}
    </span>
  );
}
