/**
 * What the administrator settings row says, decided away from the markup.
 *
 * The editor draws two things per person and they can disagree: the role, and the
 * access the role needs. Every function here exists to stop that disagreement
 * being smoothed over, because each way of smoothing it looks tidier on screen and
 * is a lie:
 *
 *   - A row with no access state yet must say "not checked", not "no access".
 *   - A refused grant must not be drawn as a pending one.
 *   - A person who already held the access must not be shown as somebody this app
 *     granted it to, because that decides what happens when they are removed.
 *
 * Kept out of the component so the states can be asserted without rendering, and
 * so the words are in one place rather than spread through JSX.
 */
import { ACCESS_PURPOSE } from '../../shared/admin-contract';
import type {
  AccessObject,
  AccessReport,
  AccessResult,
  AccessState,
  AccessTargetId,
  AdminListEntry,
} from '../../shared/admin-contract';

import type { DatabricksObject } from '../../shared/databricks-links';

export type { AccessObject, AccessReport, AccessResult, AccessState, AccessTargetId, AdminListEntry };

/**
 * Where a row came from, in three words.
 *
 * A seed row's origin is the reason it has no Remove button, so the chip and the
 * absent button are one fact rather than two coincidences.
 */
export function originLabel(entry: AdminListEntry): string {
  if (entry.origin === 'seed') return 'Set at deployment';
  return entry.addedBy ? `Added by ${entry.addedBy}` : 'Added here';
}

/** The date under an added row, or empty. Never a guess at a seed row's date. */
export function addedOn(entry: AdminListEntry): string {
  if (entry.origin === 'seed' || !entry.addedAt) return '';
  const when = new Date(entry.addedAt);
  return Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString();
}

/**
 * One word for the state, beside the sentence rather than instead of it.
 *
 * A word and not only a colour. The design note asks for a row readable at a
 * glance, and a reader who cannot distinguish the greens from the ambers gets
 * nothing from a coloured dot.
 */
export function stateWord(state: AccessState): string {
  switch (state) {
    case 'granted':
      return 'Granted';
    case 'already-held':
      return 'Already held';
    case 'refused':
      return 'Not granted';
    case 'not-configured':
      return 'Not set up';
    default:
      return 'Not checked';
  }
}

/**
 * Whether a state is one somebody has to do something about.
 *
 * Only `refused`. Not `not-checked`, which is this app's words for not yet, and
 * not `not-configured`, which is the ordinary state of a deployment that opted out
 * of billed telemetry ingestion. Drawing either as a problem trains people to
 * ignore the ones that are.
 */
export function needsAttention(state: AccessState): boolean {
  return state === 'refused';
}

/**
 * The access rows for one person, or the not-checked placeholder.
 *
 * A person the reconcile call has not answered for yet is NOT a person without
 * access. The placeholder says which, on both targets, so a row is never blank in
 * a way a reader would read as "nothing to grant".
 */
export function accessFor(email: string, reports: readonly AccessReport[]): AccessResult[] {
  const found = reports.find((report) => report.email === email);
  if (found) return found.results;
  return [pendingResult('telemetry', 'Telemetry schema'), pendingResult('billing', 'Billing tables')];
}

/**
 * A target before the server has answered for it.
 *
 * NAMES NO OBJECT, and that is not the same omission as the bug this replaced. The
 * telemetry destination is a deployment's own catalog and schema, resolved on the
 * server from configuration; a name invented here would be this screen guessing at
 * a customer's catalog, and it would be in the published tree. The row still says
 * what the access is FOR, which is the part that does not depend on the deployment,
 * so a row is legible for the second or two before the reconcile call replies.
 */
function pendingResult(target: AccessTargetId, label: string): AccessResult {
  return {
    target,
    label,
    state: 'not-checked',
    objects: [],
    purpose: ACCESS_PURPOSE[target],
    summary: 'Not checked yet.',
    grant: null,
    note: '',
  };
}

/**
 * Whether a row can name what it is about.
 *
 * The two reasons it cannot are different and the row says different things, so
 * the caller needs the question asked rather than the array's length inspected at
 * the markup: `not-configured` means there is no object and never will be on this
 * deployment, and `not-checked` means one exists but the server has not said which
 * yet.
 */
export function namesNoObject(result: AccessResult): boolean {
  return result.objects.length === 0;
}

/**
 * Which workspace object to build an "Open in Databricks" link for.
 *
 * OUT OF THE MARKUP BECAUSE GETTING IT WRONG IS SILENT. A schema sent through the
 * table branch asks `unityCatalogPath` for three dot-separated parts, is handed a
 * two-part name, returns null, and `OpenInDatabricks` then renders nothing at all --
 * by design, since it refuses to guess a link. So the telemetry row would simply
 * have had no link, with no error anywhere and nothing on screen to say a link was
 * ever intended. A test can see the difference; a reader of the JSX could not.
 *
 * The split is on the declared `kind` rather than on counting dots, because a name
 * is untrusted input here: it is a deployment's configuration string, and a
 * malformed one should produce no link rather than a link to whatever it parses as.
 */
export function linkTargetFor(object: AccessObject): DatabricksObject {
  if (object.kind === 'schema') {
    const [catalog = '', schema = ''] = object.name.split('.');
    return { kind: 'schema', catalog, schema };
  }
  return { kind: 'table', table: object.name };
}

/**
 * The line above the list: what this deployment's administration currently is.
 *
 * The empty and the unreadable cases are different sentences on purpose. Both put
 * few rows on screen and they have different remedies, and conflating them is what
 * sends somebody looking for a person who was never removed.
 */
export function listSummary(input: {
  entries: readonly AdminListEntry[];
  addedAdminsReadable: boolean;
  seedAdminCount: number;
}): string {
  if (!input.addedAdminsReadable) {
    return (
      'The stored half of this list could not be read, so only administrators set at deployment are ' +
      'shown. There may be more. Nobody has lost the role.'
    );
  }
  if (input.entries.length === 0) {
    return (
      'This deployment has no administrators. Monitoring, Ops and this page refuse everybody, and ' +
      'nobody can be added from here. Set the administrators in the deployment configuration.'
    );
  }
  const added = input.entries.length - input.seedAdminCount;
  const parts = [`${input.seedAdminCount} set at deployment`];
  if (added > 0) parts.push(`${added} added here`);
  return `${input.entries.length} administrator${input.entries.length === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

/** Whether the Add button does anything yet. Kept here so the test does not render. */
export function canSubmit(draft: string, busy: boolean): boolean {
  return !busy && draft.trim().length > 0;
}
