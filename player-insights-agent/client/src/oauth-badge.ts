/**
 * Whether this app is holding an OAuth sign-in for the reader, as a badge in the
 * header.
 *
 * WHAT THE BADGE CLAIMS, AND THE CLAIM IT USED TO MAKE. It claims one thing:
 * a sign-in reached this app and this app could read it. Authentication, not
 * authorization. It used to claim more -- green meant the presented token carried
 * every scope the deployment declares, and a token short of one went red -- and
 * that was the wrong claim for three reasons.
 *
 * First, it was not true. A token missing a declared scope authenticates
 * perfectly well; the reader is who they say they are and the app knows it. Red
 * on that reads as "you are not signed in", which is a different and more
 * alarming statement than the one the evidence supports.
 *
 * Second, a missing scope has TWO possible causes and one token cannot tell them
 * apart: the session predates the declaration, or the app has not been restarted
 * since the declaration and the scope is inert for everybody. server/lib/
 * session-freshness.ts is careful to record only the narrow fact for exactly this
 * reason. A red badge saying "not working" picks the first cause, silently.
 *
 * Third, that state has a surface of its own on the Connections page, per
 * dependency, where the refusal it explains actually appears. An amber strip
 * above every page said the same thing to everyone, whatever they came to do, and
 * was removed on 2026-08-16. A red badge would be worse than either: the sign-in
 * did not fail, it simply predates a permission the app added.
 *
 * SO A STALE SESSION IS NOW GREEN, and the tooltip on it is still the server's
 * stale sentence. That pairing is deliberate rather than an oversight: the colour
 * answers "did OAuth work", which is yes, and the words answer "what does the
 * token carry", which is the amber strip's business and is quoted here rather
 * than restated. The badge is not a summary of the app's health and must not
 * become one -- the surfaces that report a shortfall are the strip, and the
 * Connections page's identity card.
 *
 * WHEN IT IS RED, and why that is reachable rather than decorative. When no
 * OAuth sign-in reached the app at all: `identitySource` is the development
 * fallback, which means nothing authenticated this request and the app is acting
 * under a stand-in address. On a laptop that is expected and the badge is
 * honestly reporting that there is no OAuth here. On the deployed app it means
 * the platform stopped forwarding the signed-in user, which is authentication
 * failing outright and is worth a red badge on every page.
 *
 * THE TWO SILENT CASES ARE NOW DIFFERENT COLOURS. A request whose sign-in the
 * app could not read used to be drawn neutral whatever had happened, because
 * two situations arrived identically: nothing was forwarded, and an opaque
 * token was forwarded that works fine but states no scopes. `tokenScopes` is
 * null for both, `SessionReport` separated them in prose only, and keying a
 * badge on a sentence is not keying it on a fact. `signedIn` is that fact, so
 * the first is red -- on a deployed app the platform has stopped forwarding the
 * signed-in user -- and the second stays neutral, which is what an opaque token
 * deserves.
 *
 * NEITHER THE COMPARISON NOR THE SCOPE MAPPING IS REDONE HERE. `/api/identity`
 * carries the `session` report, decided in session-freshness.ts, which reuses
 * `tokenCarriesScope` because the forwarded token spells our catalog reads
 * `unity-catalog` while the bundle spells them `catalog.tables:read`. A second
 * copy of that mapping would read a token that carries a scope as one that lacks
 * it, and it has printed a GRANT for a present scope once already. This module
 * reads the report and nothing else.
 */
import type { Identity } from './app-types';
// From user-initials.ts rather than from app-state.ts, which re-exports it
// alongside the hooks: this module is pure and a test of it should not have to
// drag React and two fetches in behind one string.
import { IDENTITY_RESOLVING } from './user-initials';

/**
 * The four things the badge can be saying.
 *
 * `resolving` is drawn as an empty placeholder rather than as nothing, so the
 * cluster beside it does not jump sideways when the identity read lands. The
 * role badge holds its width for the same reason.
 */
export type OAuthBadgeState = 'resolving' | 'working' | 'not-working' | 'unknown';

/**
 * The three fields this module reads, and nothing else.
 *
 * Narrower than `Identity` so the Connections page's Identity card can pass the
 * `/api/identity` body it has already read without a second fetch or a cast.
 * `Identity` satisfies it, so every existing caller is unaffected; what the
 * type stops is a future reader of this module reaching for a fourth field and
 * quietly making the badge a summary of the app's health, which is the thing
 * the note above spends its length refusing.
 */
export type OAuthBadgeIdentity = Partial<Pick<Identity, 'signedInAs' | 'identitySource' | 'session'>>;

/**
 * What the server calls an identity that nothing signed in.
 *
 * The value is `/api/identity`'s, not this file's: `identityPayload` sets it when
 * the request carried no `x-forwarded-email`, and AccessGate reads the same
 * string to know not to put a gate in front of a laptop.
 */
export const DEVELOPMENT_FALLBACK = 'development-fallback';

/**
 * Which state the header should draw, from the identity read it already has.
 *
 * Read in this order, because the questions are nested: has anything landed, did
 * anything sign this reader in, and then what did the app manage to read of it.
 * Green requires the app to have READ the presented sign-in, which is the only
 * positive fact available here; every doubt short of that is neutral, and only an
 * absent sign-in is red.
 */
export function oauthBadgeState(identity: OAuthBadgeIdentity | null | undefined): OAuthBadgeState {
  if (!identity || identity.signedInAs === IDENTITY_RESOLVING) return 'resolving';
  if (identity.identitySource === DEVELOPMENT_FALLBACK) return 'not-working';
  const session = identity.session;
  // A server too old to report one. Nothing was established, and a badge that
  // reads silence as success is the defect this badge exists to avoid.
  if (!session) return 'unknown';
  // NOTHING WAS FORWARDED, which on a deployed app is authentication failing
  // outright: the platform stopped handing over the signed-in user. It used to
  // arrive here as neutral grey alongside the harmless case below, because both
  // leave `tokenScopes` null and the badge had no other fact to key on.
  if (!session.signedIn) return 'not-working';
  // The presented sign-in listed what it carries, so it reached this app and was
  // read: `current`, `stale` and a deployment that declares nothing all qualify.
  // Whether it carries enough is a separate question with its own surface.
  if (session.tokenScopes && session.tokenScopes.length > 0) return 'working';
  // A sign-in reached the app and states no scopes -- an opaque token doing its
  // job. Neutral, because nothing failed and nothing was established.
  return 'unknown';
}

/**
 * The word every drawn state carries.
 *
 * Exported because the badge reserves its own width by rendering this word
 * hidden while the identity read is in flight, and a second copy of the string
 * over there would be a placeholder that stopped matching the thing it is
 * holding room for the day somebody reworded one of them.
 */
export const OAUTH_BADGE_WORD = 'OAuth';

/**
 * The word on the badge, which is "OAuth" in every state that is drawn.
 *
 * The state is carried by the colour and the icon rather than by the wording,
 * which is the handoff's design and is why the same badge can sit against a
 * different row on the Connections identity card. Empty while resolving: a chip
 * that says "OAuth" before anything is known has made a claim.
 */
export function oauthBadgeLabel(state: OAuthBadgeState): string {
  return state === 'resolving' ? '' : OAUTH_BADGE_WORD;
}

/**
 * What a screen reader is told, which is never just "OAuth".
 *
 * The visible word is a category and the badge's whole meaning is its colour, so
 * an accessible name of "OAuth" would announce the label and drop the fact. Each
 * of these names is about the sign-in reaching the app, and none of them claims
 * anything about what it is permitted to do: that is the distinction the badge
 * was rewired to respect.
 */
export function oauthBadgeAccessibleName(state: OAuthBadgeState): string {
  if (state === 'working') return 'OAuth sign-in reached this app and was read';
  if (state === 'not-working') return 'OAuth sign-in did not reach this app';
  if (state === 'unknown') return 'OAuth sign-in could not be checked';
  return '';
}

/**
 * The tooltip: the server's own sentence, wherever there is one.
 *
 * Verbatim, and not paraphrased. `session.explanation` is written beside the
 * evidence that produced it and is held against that evidence by
 * shared/stated-cause.ts, so rewording it here would be a claim nothing audits.
 * On a stale session that sentence names the missing permission under a green
 * badge, which is the split this module documents at the top: the colour is about
 * authentication and the words are about what the token carries.
 *
 * The two sentences below are supplied only where the server supplied none, and
 * neither is a diagnosis -- one is the absence of a report, the other the absence
 * of a sign-in.
 */
export function oauthBadgeTitle(identity: OAuthBadgeIdentity | null | undefined): string {
  const state = oauthBadgeState(identity);
  if (state === 'resolving') return '';
  const explanation = identity?.session?.explanation?.trim();
  if (explanation) return explanation;
  if (state === 'not-working') {
    return 'No OAuth sign-in reached this app, so nothing here is running as a signed-in user.';
  }
  return 'This app did not report anything about the sign-in this browser presented, so whether it reached the app at all is unknown.';
}
