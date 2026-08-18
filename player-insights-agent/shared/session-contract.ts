/**
 * What `/api/identity` reports about the sign-in the browser presented.
 *
 * Shared because the server decides it and the client renders it, and the words
 * have to be the same words. The copy lives on the SERVER side of this contract
 * on purpose: the guard in `stated-cause.ts` can only hold prose against the
 * evidence behind it if the two are written in the same place, and a second copy
 * of the sentence in a React component is a sentence nothing audits.
 */
import type { Diagnosis } from './stated-cause';

/**
 * Whether the presented sign-in carries what the app asks for.
 *
 * `undetermined` is a real answer, not a loading state. It means the comparison
 * could not be made, which happens for reasons that are nobody's fault: a
 * request with no forwarded token, a token that does not list its own
 * permissions, a deployment that was not told which permissions it asks for.
 */
export type SessionState = 'current' | 'stale' | 'undetermined';

export interface SessionReport extends Diagnosis {
  state: SessionState;
  /**
   * Whether a sign-in was forwarded to this app at all.
   *
   * SEPARATE FROM `state` BECAUSE `undetermined` COVERS TWO SITUATIONS THAT ARE
   * NOT ALIKE. Nothing was forwarded, which on a deployed app means the
   * platform stopped handing over the signed-in user and authentication has
   * failed outright; or something was forwarded that this app could not read,
   * which is an opaque token doing its job and stating no scopes. Both left
   * `tokenScopes` null, so the header badge drew them the same neutral grey and
   * the more serious of the two was invisible.
   *
   * Required rather than optional, so a report that reaches a badge cannot
   * decline to answer and be read as the harmless one.
   */
  signedIn: boolean;
  /**
   * The permissions the presented token lists, or null when it listed none.
   *
   * REPORTED BECAUSE NOTHING REPORTED IT. This is the single fact the whole
   * stale-session diagnosis turns on, it was already being read inside the probe
   * module, and no surface anywhere put it in front of a reader. Somebody
   * checking the diagnosis by hand had no way to see the thing it was about.
   */
  tokenScopes: string[] | null;
  /** The permissions this deployment asks for, or null when it was not told. */
  declaredScopes: string[] | null;
  /** Declared permissions the presented token does not carry. */
  missingScopes: string[];
}
