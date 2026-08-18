/**
 * What the administrator settings send over the wire.
 *
 * Shared so the editor and the routes cannot disagree about the shape of a row.
 * The reason that matters more here than it usually does: a row on this screen
 * carries TWO facts that can differ, the role and the access, and a client that
 * modelled them as one would have to pick which of them the row means.
 *
 * Nothing in this file decides anything. The origin of a row and whether it may be
 * removed are decided on the server, because the button the screen draws and the
 * refusal the route makes have to be one fact rather than two implementations of
 * one rule.
 */

/** The objects an administrator needs read access to for the admin tabs to work. */
export type AccessTargetId = 'telemetry' | 'billing';

/**
 * WHY THE ROW IS WORTH HAVING, which is the fact it used to leave out.
 *
 * A row saying access to something was already held tells a reader nothing they
 * can act on. What the access is FOR is what turns it into a fact: an admin whose
 * Ops health block is empty can look at this and know which grant is the reason.
 *
 * Here rather than on the server because the editor needs the same words BEFORE
 * the server has answered. The reconcile call is a POST and takes a cold warehouse
 * to reply, so the rows are drawn from a placeholder first, and a placeholder that
 * could not say what the row was about would be a row worth nothing for as long as
 * it was on screen. One declaration, both readers.
 */
export const ACCESS_PURPOSE: Readonly<Record<AccessTargetId, string>> = {
  telemetry: 'What the Ops health block reads.',
  billing: 'What the Ops cost block reads.',
};

/**
 * One Unity Catalog object a target needs, named so a reader can go and see it.
 *
 * `kind` is carried rather than guessed from the number of dots in `name`,
 * because the two cases genuinely differ and the guess gets one of them wrong: a
 * telemetry destination is a two-level SCHEMA and a billing object is a
 * three-level TABLE, and a schema browsed as a table produces a link to nothing.
 *
 * NOTHING HERE IS A LITERAL IN THIS REPOSITORY. The telemetry name is a
 * deployment's own catalog and schema, resolved from configuration at runtime, and
 * that is what keeps a customer's catalog out of the published tree.
 */
export interface AccessObject {
  /** Fully qualified and unquoted, as Unity Catalog spells it. */
  name: string;
  kind: 'schema' | 'table';
}

/**
 * A missing grant: the object, the privilege, and a statement somebody can run.
 *
 * The app's existing grant pattern, and the same three fields the Ops cost block
 * uses, so a refusal reads identically wherever it appears.
 */
export interface AccessGrant {
  object: string;
  privilege: string;
  statement: string;
}

/**
 * The five states a target can be in, and none of them is a maybe.
 *
 *   granted         The app made the grant in this action.
 *   already-held    The person already had it, so nothing was done and nothing is
 *                   owed back when they are removed.
 *   refused         Unity Catalog said no. The role was still granted, and `grant`
 *                   carries what somebody with authority runs.
 *   not-configured  This deployment has no such object, so there is nothing to
 *                   grant and nothing is wrong.
 *   not-checked     Not checked YET, which is what those words mean everywhere in
 *                   this app. NOT a refusal.
 */
export type AccessState = 'granted' | 'already-held' | 'refused' | 'not-configured' | 'not-checked';

export interface AccessResult {
  target: AccessTargetId;
  /** What the reader calls it, as the row's label. */
  label: string;
  state: AccessState;
  /**
   * The objects this target covers, spelled out, in the order they are granted.
   *
   * EMPTY IS MEANINGFUL AND IS NOT A RENDERING PROBLEM. Empty on a
   * 'not-configured' row because there is genuinely no object -- the row must read
   * as not set up rather than showing a blank name -- and empty on a placeholder
   * the server has not answered for yet.
   */
  objects: AccessObject[];
  /** Why this access matters, from {@link ACCESS_PURPOSE}. */
  purpose: string;
  /**
   * The extra line, or EMPTY when the state and the object names already say it.
   *
   * Empty is the normal case for 'already-held': the word beside a name that is
   * spelled out is the whole fact, and a sentence repeated under every target of
   * every person was two lines per row saying nothing specific. The states that
   * DO carry one are the ones where something happened or is owed -- granted,
   * refused, not configured, not checked.
   */
  summary: string;
  /** Present only when `state` is 'refused'. */
  grant: AccessGrant | null;
  /** The extra sentence for a refusal needing authority nobody on screen has. Empty otherwise. */
  note: string;
}

export interface AccessReport {
  email: string;
  results: AccessResult[];
}

/**
 * One row of the list, with where it came from.
 *
 * `origin` is the whole of what the row can do: a seed row is deployment
 * configuration and cannot be removed from this screen, an added row can.
 */
export interface AdminListEntry {
  email: string;
  origin: 'seed' | 'added';
  /** Who added them, for an added row. Empty for a seed row. */
  addedBy: string;
  /** When, for an added row. Empty for a seed row. */
  addedAt: string;
  /** Whether this row is the person reading the screen. */
  isYou: boolean;
  removable: boolean;
}

export interface AdminListPayload {
  entries: AdminListEntry[];
  /** False when the stored half could not be read. The screen says so. */
  addedAdminsReadable: boolean;
  seedAdminCount: number;
}

/**
 * The list and the access state in one payload.
 *
 * `access` is EMPTY ON A PLAIN READ, and that is not "no access": it is "this call
 * did not look". The editor's reconcile call on load is what fills it, and until it
 * answers the rows show the access as not checked.
 */
export interface AdminEditorPayload extends AdminListPayload {
  access: AccessReport[];
}
