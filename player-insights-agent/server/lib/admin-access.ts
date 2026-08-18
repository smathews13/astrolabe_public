/**
 * Granting the role, and granting the access the role needs.
 *
 * admin-roles.ts opens tabs. This file is the reason those tabs have anything in
 * them: Monitoring reads the app's own telemetry and the Ops cost block reads the
 * Databricks billing tables, and neither is readable by somebody who was merely
 * named on the admin list. So adding an admin performs two things in one action,
 * and this module is the second one.
 *
 * THIS IS A DELIBERATE NARROWING OF RULE 3 IN admin-roles.ts, WHICH SAYS THE ROLE
 * GRANTS NO DATA. That rule still holds where it matters: nothing here widens
 * what a question may read, the app's own schema is untouched, and a consumer's
 * query still runs under the consumer's grants. What the add action now also does
 * is make a separate, named, audited Unity Catalog grant on TWO objects, both of
 * which are records of the app's own operation rather than anybody's data: the
 * telemetry schema the platform writes request logs into, and the billing tables.
 * If you are here to give an admin access to a player table, this is still the
 * wrong file.
 *
 * WHO RUNS THE GRANT, AND WHY IT IS NOT THE APP. Every statement below runs under
 * the FORWARDED TOKEN OF THE ADMIN WHO PRESSED THE BUTTON, not under the app's
 * own service principal. Two reasons, and the second is the important one:
 *
 *   1. It would not work. The telemetry schema is created by the bundle, so the
 *      deployer owns it and the app's service principal holds nothing on it. An
 *      app-run grant would fail on every deployment, which is a feature that
 *      reports failure forever.
 *   2. It would make this app a way to hand out Unity Catalog privileges. The
 *      admin list is edited inside the app by admins the app itself appointed. If
 *      the app granted with its own authority, adding a name here would widen
 *      real access without any Unity Catalog decision being made by anybody who
 *      holds authority over the object. Running as the acting human means the
 *      grant succeeds exactly when that human could have run it by hand, which is
 *      the correct answer, and the audit row names them rather than the app.
 *
 * The consequence is honest and worth stating plainly: an admin without authority
 * over these objects can still add another admin, and the access half will refuse.
 * That is reported, never hidden, and the statement someone with authority can run
 * is put on screen. See `AccessResult`.
 */
import { columnText, normalizeAdminEmail, type AdminStore } from './admin-roles';
import { ADMIN_GRANTS_TABLE } from './admin-roles-schema';
import { ACCESS_PURPOSE } from '../../shared/admin-contract';
import type {
  AccessGrant,
  AccessObject,
  AccessReport,
  AccessResult,
  AccessState,
  AccessTargetId,
} from '../../shared/admin-contract';

export type { AccessGrant, AccessObject, AccessReport, AccessResult, AccessState, AccessTargetId };

/**
 * The variable naming the catalog and schema app telemetry writes into.
 *
 * DECLARED IN TWO PLACES ON PURPOSE, and the duplication is the lesser evil.
 * `server/lib/ops-telemetry.ts` declares the same name for the Ops tab's reader.
 * The two are independent readers of one deployment variable rather than one
 * module importing the other, because these landed as separate pieces of work and
 * a cross-import would make either one un-buildable without the other. The NAME
 * is the contract. If it changes, it changes in both.
 *
 * UNSET IS VALID AND MEANS THERE IS NOTHING TO GRANT. A customer target sets no
 * telemetry destination, because app telemetry ingestion is billed and a customer
 * must not be opted into a charge nobody agreed to. So the absent case is the
 * common case, not the broken one, and it is reported as "not configured" rather
 * than as a failure.
 */
export const TELEMETRY_SCHEMA_ENV = 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA';

/**
 * The billing tables the Ops cost block reads.
 *
 * `system.billing` is a Databricks-managed catalog, and that is the whole
 * difficulty with granting on it. See `BILLING_AUTHORITY_NOTE`.
 */
export const BILLING_TABLES: readonly string[] = ['system.billing.usage', 'system.billing.list_prices'];

/**
 * What almost certainly has to happen by hand, and why, in one place.
 *
 * Shown when a billing grant is refused, which is the EXPECTED outcome rather
 * than a surprise. Databricks documents access to `system` as granted by somebody
 * holding BOTH the account admin and the metastore admin role; nobody holds either
 * by virtue of being an administrator of this app, and being a workspace admin is
 * not enough. So this refusal is the normal path, not a fault to chase.
 *
 * The app attempts it anyway rather than assuming, for two reasons. A deployment
 * whose app admins ARE metastore admins exists, and telling those people to go and
 * do a thing they can do from here is its own defect. And an assumption printed as
 * a fact would be this screen guessing at Unity Catalog's answer instead of asking
 * for it, which is the habit the rest of this module is built to avoid.
 */
export const BILLING_AUTHORITY_NOTE =
  'This one usually cannot be granted from here. Databricks requires an account admin who is also a ' +
  'metastore admin to grant on system tables. Ask one to run this, or to grant it to you with grant ' +
  'option so this screen can do it next time.';

/** The parts of a Unity Catalog privilege, in the form the statements take. */
type SecurableKind = 'CATALOG' | 'SCHEMA' | 'TABLE';

interface Privilege {
  kind: SecurableKind;
  /** Fully qualified, unquoted. */
  name: string;
  privilege: string;
}

/**
 * What one statement did.
 *
 * `rows` is populated only for the reads. A statement that refused carries the
 * status beside the message, on the same reasoning as the statement executor in
 * access-verification.ts: a permission refusal routinely arrives as a code with no
 * body, and `HTTP 403` as prose reads as unclassifiable to anything matching on
 * wording.
 */
export interface SqlOutcome {
  ok: boolean;
  status?: number;
  message?: string;
  rows?: string[][];
}

export type SqlRunner = (statement: string) => Promise<SqlOutcome>;

/** Backtick-quote one identifier part, escaping any backtick inside it. */
function quote(part: string): string {
  return '`' + part.replace(/`/g, '``') + '`';
}

function quotedName(fullName: string): string {
  return fullName.split('.').map(quote).join('.');
}

/**
 * The configured telemetry destination, or empty.
 *
 * Accepts `catalog.schema` and nothing else, matching `telemetrySchema` in
 * ops-telemetry.ts. One part is not a schema and three would be a table, and
 * repairing either would point a GRANT at an object the deployer did not name.
 */
export function telemetryDestination(raw: string | undefined = process.env[TELEMETRY_SCHEMA_ENV]): string {
  const candidate = (raw ?? '').trim().replace(/^`|`$/g, '');
  if (!candidate) return '';
  const parts = candidate.split('.').filter((part) => part.length > 0);
  if (parts.length !== 2) {
    console.warn(`[admin] ${TELEMETRY_SCHEMA_ENV} is ${JSON.stringify(candidate)}, which is not a catalog and ` +
        'schema. No telemetry grant will be attempted, and the editor reports it as not configured rather ' +
        'than granting on a guess.'
    );
    return '';
  }
  return parts.join('.');
}

/**
 * The privileges one target needs, in the order they must be granted.
 *
 * Traversal first, then the read. Unity Catalog hides an object the caller cannot
 * traverse, so `SELECT` without `USE SCHEMA` produces a table that reads as
 * absent rather than as forbidden, which is the confusion this app has been
 * bitten by more than once.
 *
 * `SELECT ON SCHEMA` rather than on each table, for telemetry, and that is
 * load-bearing: the platform creates `otel_logs`, `otel_spans` and `otel_metrics`
 * itself, on its own schedule, AFTER the deploy. A grant enumerating them today
 * would silently miss whichever one had not been created yet, and the admin would
 * hold access to two of three tables with nothing on screen to say which.
 */
export function privilegesFor(target: AccessTargetId, telemetry: string): Privilege[] {
  if (target === 'telemetry') {
    if (!telemetry) return [];
    const [catalog] = telemetry.split('.');
    return [
      { kind: 'CATALOG', name: catalog, privilege: 'USE CATALOG' },
      { kind: 'SCHEMA', name: telemetry, privilege: 'USE SCHEMA' },
      { kind: 'SCHEMA', name: telemetry, privilege: 'SELECT' },
    ];
  }
  return [
    { kind: 'CATALOG', name: 'system', privilege: 'USE CATALOG' },
    { kind: 'SCHEMA', name: 'system.billing', privilege: 'USE SCHEMA' },
    ...BILLING_TABLES.map((table): Privilege => ({ kind: 'TABLE', name: table, privilege: 'SELECT' })),
  ];
}

export function grantStatement(privilege: Privilege, principal: string): string {
  return `GRANT ${privilege.privilege} ON ${privilege.kind} ${quotedName(privilege.name)} TO ${quote(principal)};`;
}

export function revokeStatement(privilege: Privilege, principal: string): string {
  return `REVOKE ${privilege.privilege} ON ${privilege.kind} ${quotedName(privilege.name)} FROM ${quote(principal)};`;
}

/** What the person already holds on one object, which is how provenance is established. */
export function showGrantsStatement(privilege: Privilege, principal: string): string {
  return `SHOW GRANTS ${quote(principal)} ON ${privilege.kind} ${quotedName(privilege.name)}`;
}

/** The object a target's refusal names, and the privilege that matters on it. */
function headline(target: AccessTargetId, telemetry: string): { object: string; privilege: string } {
  return target === 'telemetry'
    ? { object: telemetry, privilege: 'SELECT' }
    : { object: 'system.billing', privilege: 'SELECT' };
}

export function labelFor(target: AccessTargetId): string {
  return target === 'telemetry' ? 'Telemetry schema' : 'Billing tables';
}

/**
 * The objects a target covers, by name, for the row to print.
 *
 * The reason this is not `privilegesFor` with the duplicates removed: that list is
 * what has to be GRANTED, and it is deliberately wider than what the row is about.
 * It includes `USE CATALOG` on the containing catalog and `USE SCHEMA` on the
 * parent, which are traversal -- necessary, and not what the reader came to see.
 * Naming them here would put four objects under the telemetry row, three of which
 * answer a question nobody asked, and bury the one that matters.
 *
 * So: the destination schema for telemetry, and the two tables for billing. The
 * traversal is still granted, still recorded, and still in the copyable statement
 * block when a grant is refused.
 *
 * EMPTY FOR AN UNCONFIGURED TELEMETRY DESTINATION, which is a customer target's
 * ordinary state. There is no object, so the row names none and says it is not set
 * up. A placeholder name here would be this screen inventing a catalog.
 */
export function objectsFor(target: AccessTargetId, telemetry: string): AccessObject[] {
  if (target === 'telemetry') {
    return telemetry ? [{ name: telemetry, kind: 'schema' }] : [];
  }
  // Named even though the app almost certainly cannot grant on them. Whose
  // authority is needed is a separate fact from what the object is, and a reader
  // who has to go and ask a metastore admin needs to be able to say which tables.
  return BILLING_TABLES.map((name): AccessObject => ({ name, kind: 'table' }));
}

/**
 * One result, so the fields every row needs cannot be forgotten at one site.
 *
 * Every construction below went through here after `objects` and `purpose` were
 * added, because the previous shape had six literal object sites and a row that
 * silently lost its object names would look exactly like the bug being fixed:
 * a state word beside a label that names nothing.
 */
function accessResult(input: {
  target: AccessTargetId;
  telemetry: string;
  state: AccessState;
  summary: string;
  grant?: AccessGrant | null;
  note?: string;
  /** Overridden only where the row is not about this deployment's objects. */
  objects?: AccessObject[];
}): AccessResult {
  return {
    target: input.target,
    label: labelFor(input.target),
    state: input.state,
    objects: input.objects ?? objectsFor(input.target, input.telemetry),
    purpose: ACCESS_PURPOSE[input.target],
    summary: input.summary,
    grant: input.grant ?? null,
    note: input.note ?? '',
  };
}

/** Every statement a target needs, as one copyable block. */
export function grantFor(target: AccessTargetId, telemetry: string, principal: string): AccessGrant {
  const privileges = privilegesFor(target, telemetry);
  return {
    ...headline(target, telemetry),
    statement: privileges.map((privilege) => grantStatement(privilege, principal)).join('\n'),
  };
}

/**
 * Whether this person already holds this privilege.
 *
 * Three answers, and the third is the point: `null` means the question could not
 * be asked, which happens whenever the acting admin cannot read grants on the
 * object. It is recorded as `unknown` provenance and NEVER revoked later.
 *
 * `ALL PRIVILEGES` counts as holding it, because it is. Matching any cell in the
 * row rather than a fixed column index, because the column order of `SHOW GRANTS`
 * is not something to bet a revoke on.
 */
export async function heldAlready(
  run: SqlRunner,
  privilege: Privilege,
  principal: string
): Promise<boolean | null> {
  const outcome = await run(showGrantsStatement(privilege, principal));
  if (!outcome.ok || !outcome.rows) return null;
  const wanted = privilege.privilege.toUpperCase();
  for (const row of outcome.rows) {
    const cells = row.map((cell) => String(cell ?? '').trim().toUpperCase());
    if (cells.includes(wanted) || cells.includes('ALL PRIVILEGES')) return true;
  }
  return false;
}

export type Provenance = 'app-granted' | 'pre-existing' | 'unknown';

/**
 * Write down what was true before the grant, at the one moment it is observable.
 *
 * Best effort, and never allowed to fail the grant it describes. A lost row is
 * not a lost grant: it degrades a later revoke to "this app cannot prove it
 * granted this", and the revoke path treats an absent row exactly as it treats
 * `unknown`, which is to change nothing.
 */
async function recordProvenance(
  store: AdminStore,
  entry: { email: string; target: AccessTargetId; object: string; privilege: string; provenance: Provenance; actor: string }
): Promise<void> {
  try {
    await store.query(`INSERT INTO ${ADMIN_GRANTS_TABLE} (email, target, object, privilege, provenance, actor)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email, object, privilege)
       DO UPDATE SET provenance = EXCLUDED.provenance, actor = EXCLUDED.actor, recorded_at = NOW()`,
      [entry.email, entry.target, entry.object, entry.privilege, entry.provenance, entry.actor]
    );
  } catch (error) {
    console.error(`[admin] PROVENANCE NOT RECORDED for ${entry.privilege} on ${entry.object} for ${entry.email}: ` +
        `${(error as Error).message}. The grant itself went ahead. A later removal will leave this ` +
        'privilege in place, because this app can no longer show it was the one that added it.'
    );
  }
}

export interface ProvenanceRow {
  email: string;
  target: AccessTargetId;
  object: string;
  privilege: string;
  provenance: Provenance;
}

export async function readProvenance(store: AdminStore, email: string): Promise<ProvenanceRow[]> {
  const result = await store.query(`SELECT email, target, object, privilege, provenance FROM ${ADMIN_GRANTS_TABLE}
     WHERE email = $1 ORDER BY recorded_at ASC`,
    [normalizeAdminEmail(email)]
  );
  return result.rows.map((row) => ({
    email: columnText(row.email),
    target: (columnText(row.target) === 'billing' ? 'billing' : 'telemetry') as AccessTargetId,
    object: columnText(row.object),
    privilege: columnText(row.privilege),
    // Anything this app cannot read as one of the three provenances is treated as
    // `unknown`, which is the reading that never revokes.
    provenance: (['app-granted', 'pre-existing'].includes(columnText(row.provenance))
      ? columnText(row.provenance)
      : 'unknown') as Provenance,
  }));
}

/** The line a refusal shows, short enough to sit in a table row. */
function refusalSummary(message: string | undefined): string {
  const raw = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Access not granted. Unity Catalog refused and gave no reason.';
  const clipped = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
  return `Access not granted. ${clipped}`;
}

/**
 * A target this deployment has no object for.
 *
 * Only telemetry reaches this: a customer target sets no destination, because
 * ingestion is billed. The line has to carry the whole meaning, because there is no
 * name beside it to carry any of it, and it must not read as something broken.
 */
function notConfigured(target: AccessTargetId): AccessResult {
  return accessResult({
    target,
    telemetry: '',
    state: 'not-configured',
    summary:
      'This deployment writes no app telemetry, so there is no schema to read and nothing to grant. ' +
      'Nothing is wrong. The destination is set in the deployment configuration.',
  });
}

function notChecked(target: AccessTargetId, telemetry: string, reason: string): AccessResult {
  return accessResult({ target, telemetry, state: 'not-checked', summary: reason });
}

/**
 * Why no statement can be run, in the words the editor prints.
 *
 * Two different absences, kept apart because they are fixed in different places
 * and by different people. Neither is a refusal and neither is reported as one.
 */
export const NO_WAREHOUSE_REASON =
  'Not checked. This deployment has no SQL warehouse configured, so no grant could be attempted.';

export const NO_TOKEN_REASON =
  'Not checked. This session has no forwarded sign-in token, so a grant would have to be made by ' +
  'the app itself rather than by you. It is not, deliberately.';

/**
 * Grant one person everything the admin tabs need, and say what happened.
 *
 * IDEMPOTENT, in both halves. `heldAlready` short-circuits a privilege the person
 * has, and `GRANT` is itself a no-op when repeated, so running this twice makes
 * no second change and reports 'already-held' the second time.
 *
 * A REFUSAL ON ONE PRIVILEGE FAILS THE WHOLE TARGET, and the earlier successes
 * are left in place rather than rolled back. Half a target is not access: an admin
 * holding `USE SCHEMA` and not `SELECT` cannot read telemetry, so reporting the
 * target as anything but refused would be reporting success for a half-completed
 * action. The grants that did land are idempotent and harmless, and the statement
 * block on screen re-runs all of them.
 */
export async function applyAccess(input: {
  run: SqlRunner | null;
  store: AdminStore;
  email: string;
  actor: string;
  telemetry: string;
  /** Why nothing could be run, when `run` is null. */
  unavailable?: string;
}): Promise<AccessResult[]> {
  const email = normalizeAdminEmail(input.email);
  const targets: AccessTargetId[] = ['telemetry', 'billing'];
  const results: AccessResult[] = [];

  for (const target of targets) {
    const privileges = privilegesFor(target, input.telemetry);
    if (privileges.length === 0) {
      results.push(notConfigured(target));
      continue;
    }
    if (!input.run) {
      results.push(notChecked(target, input.telemetry, input.unavailable ?? NO_WAREHOUSE_REASON));
      continue;
    }

    let refusal: SqlOutcome | null = null;
    let anyGranted = false;
    for (const privilege of privileges) {
      const held = await heldAlready(input.run, privilege, email);
      if (held === true) {
        await recordProvenance(input.store, {
          email,
          target,
          object: privilege.name,
          privilege: privilege.privilege,
          provenance: 'pre-existing',
          actor: input.actor,
        });
        continue;
      }
      const outcome = await input.run(grantStatement(privilege, email));
      if (!outcome.ok) {
        refusal = outcome;
        break;
      }
      anyGranted = true;
      await recordProvenance(input.store, {
        email,
        target,
        object: privilege.name,
        privilege: privilege.privilege,
        // `held === false` is the only evidence that this app is the reason the
        // privilege is there. A null check result grants and records `unknown`,
        // which is never revoked.
        provenance: held === false ? 'app-granted' : 'unknown',
        actor: input.actor,
      });
    }

    if (refusal) {
      results.push(accessResult({
          target,
          telemetry: input.telemetry,
          state: 'refused',
          summary: refusalSummary(refusal.message),
          grant: grantFor(target, input.telemetry, email),
          note: target === 'billing' ? BILLING_AUTHORITY_NOTE : '',
        })
      );
      continue;
    }
    results.push(accessResult({
        target,
        telemetry: input.telemetry,
        state: anyGranted ? 'granted' : 'already-held',
        // ALREADY-HELD CARRIES NO LINE, on purpose. It used to say "Read access was
        // already there. Nothing changed, and removal will not take it away.",
        // printed under every target of every person -- two lines per row, the same
        // two lines, naming nothing. The state word beside a spelled-out object name
        // is the fact; the removal rule it was carrying is a rule about this screen
        // rather than about one row, and the editor states it once beneath the list.
        //
        // Granted keeps one, because it says the thing already-held's did not: this
        // app is the reason the access is there, so removing the person takes it
        // back. That is a consequence of the action just taken and is not inferable
        // from the word.
        summary: anyGranted
          ? 'Granted just now by this app, so removing them takes it away again.'
          : '',
      })
    );
  }
  return results;
}

/**
 * What a removal handed back, which is a different kind of thing from a row.
 *
 * The results below are never drawn as target rows: the editor turns them into the
 * one sentence it prints after somebody is removed. So they carry no objects and no
 * purpose, and `label` is the word 'Access' rather than a target's name, because
 * a revoke spans both targets and every privilege recorded under them.
 *
 * Given its own helper rather than sharing {@link accessResult} so that neither
 * grows a flag for whether it is really the other. A future reader adding a field
 * to a row has one site to change and an obvious answer for this one.
 */
function removalResult(input: {
  state: AccessState;
  summary: string;
  grant?: AccessGrant | null;
  note?: string;
}): AccessResult {
  return {
    target: 'telemetry',
    label: 'Access',
    state: input.state,
    objects: [],
    purpose: '',
    summary: input.summary,
    grant: input.grant ?? null,
    note: input.note ?? '',
  };
}

/**
 * Privileges this app grants and then never takes back, on purpose.
 *
 * `USE CATALOG` is the root of everything in a catalog and grants no read on its
 * own: it is traversal, and without it Unity Catalog hides objects rather than
 * refusing them. Revoking it is the one revoke here that can break something
 * nobody asked this app to touch, and the sequence is ordinary rather than
 * contrived: this app grants traversal on the catalog so an admin can reach the
 * telemetry schema, a data owner later grants that same person `SELECT` on a table
 * in the same catalog, and then somebody removes them from the admin list. Taking
 * the traversal back would make that table read as absent, in a way whose cause is
 * two unrelated actions apart.
 *
 * Leaving it costs nothing measurable: traversal on a catalog reveals no rows, and
 * the privileges that DO grant reading are revoked as normal. The removal notice
 * says the traversal was left, so this decision is on screen rather than only here.
 */
function keptOnRemoval(row: { privilege: string }): boolean {
  return row.privilege.toUpperCase() === 'USE CATALOG';
}

/**
 * What was left alone, and which of the two reasons it was left for.
 *
 * Both sentences or neither. A reader deciding whether this person can still see
 * something needs to know that some of what they hold was never this app's, and
 * that some of it was and was kept anyway.
 */
function leftInPlaceNote(theirs: number, kept: number): string {
  const parts: string[] = [];
  if (theirs > 0) parts.push('Access this app did not grant was left in place.');
  if (kept > 0) {
    parts.push(
      'Permission to see into the catalog was left in place. It shows no data on its own, and taking it ' +
        'back could hide tables this person was given for another reason.'
    );
  }
  return parts.join(' ');
}

/**
 * Hand back what this app handed out, and nothing else.
 *
 * THE ONLY THING REVOKED IS A PRIVILEGE RECORDED AS `app-granted`. A privilege
 * recorded as `pre-existing` was there before, a privilege recorded as `unknown`
 * could not be checked, and an absent row is no claim at all. All three are left
 * alone and reported as left alone, because Unity Catalog keeps no record that
 * would let anybody put back access this app removed by guessing.
 *
 * A failed revoke keeps its provenance row. A successful one deletes it, so the
 * app stops claiming a privilege it no longer added.
 */
export async function withdrawAccess(input: {
  run: SqlRunner | null;
  store: AdminStore;
  email: string;
  telemetry: string;
  unavailable?: string;
}): Promise<AccessResult[]> {
  const email = normalizeAdminEmail(input.email);
  let rows: ProvenanceRow[];
  try {
    rows = await readProvenance(input.store, email);
  } catch (error) {
    console.warn(`[admin] The grant record for ${email} could not be read (${(error as Error).message}), so nothing ` +
        'was revoked. Leaving access in place is the safe reading: this app cannot show it was the one ' +
        'that granted it.'
    );
    return [
      removalResult({
        state: 'not-checked',
        summary:
          'Not checked. The record of what this app granted could not be read, so no access was taken away.',
      }),
    ];
  }

  // Three groups, not two, because two of them are left alone for different
  // reasons and a reader is owed the right one. `theirs` was never this app's to
  // take. `kept` was this app's and is left anyway; see keptOnRemoval.
  const mine = rows.filter((row) => row.provenance === 'app-granted' && !keptOnRemoval(row));
  const kept = rows.filter((row) => row.provenance === 'app-granted' && keptOnRemoval(row));
  const theirs = rows.filter((row) => row.provenance !== 'app-granted');
  const leftInPlace = leftInPlaceNote(theirs.length, kept.length);
  const results: AccessResult[] = [];

  if (mine.length === 0) {
    results.push(removalResult({
        state: 'already-held',
        summary:
          theirs.length + kept.length > 0
            ? 'No read access to take away.'
            : 'No access to take away. This app granted none.',
        note: leftInPlace,
      })
    );
    return results;
  }

  if (!input.run) {
    results.push(removalResult({ state: 'not-checked', summary: input.unavailable ?? NO_WAREHOUSE_REASON }));
    return results;
  }

  const failed: ProvenanceRow[] = [];
  const revoked: ProvenanceRow[] = [];
  for (const row of mine) {
    const privilege: Privilege = {
      kind: row.object.split('.').length === 1 ? 'CATALOG' : row.object.split('.').length === 2 ? 'SCHEMA' : 'TABLE',
      name: row.object,
      privilege: row.privilege,
    };
    const outcome = await input.run(revokeStatement(privilege, email));
    if (outcome.ok) revoked.push(row);
    else failed.push(row);
  }

  for (const row of revoked) {
    try {
      await input.store.query(`DELETE FROM ${ADMIN_GRANTS_TABLE} WHERE email = $1 AND object = $2 AND privilege = $3`,
        [email, row.object, row.privilege]
      );
    } catch (error) {
      console.error(`[admin] The grant record for ${row.privilege} on ${row.object} could not be cleared: ` +
          `${(error as Error).message}. The revoke itself succeeded.`
      );
    }
  }

  results.push(removalResult({
      state: failed.length > 0 ? 'refused' : 'granted',
      summary:
        failed.length > 0
          ? `Access not fully taken back. ${failed.length} of ${mine.length} statements were refused.`
          : 'Access taken back.',
      grant:
        failed.length > 0
          ? {
              object: failed.map((row) => row.object).join(', '),
              privilege: failed.map((row) => row.privilege).join(', '),
              statement: failed
                .map((row) =>
                  revokeStatement(
                    {
                      kind:
                        row.object.split('.').length === 1 ? 'CATALOG' : row.object.split('.').length === 2 ? 'SCHEMA' : 'TABLE',
                      name: row.object,
                      privilege: row.privilege,
                    },
                    email
                  )
                )
                .join('\n'),
            }
          : null,
      note: leftInPlace,
    })
  );
  return results;
}

/**
 * Bring every admin's access up to date with their role, whatever gave them it.
 *
 * WHY THIS RUNS WHEN THE EDITOR LOADS RATHER THAN AT STARTUP, which was the other
 * option and is the wrong one here. Seed admins come from bundle configuration and
 * never pass through the Add button, so without this they hold the role and none
 * of the access. Reconciling them needs somebody's authority to grant with, and at
 * startup there is nobody: there is no request, no signed-in user and no forwarded
 * token, so the only credential available is the app's own service principal,
 * which holds nothing on the telemetry schema and must not hold anything on it for
 * the reason in this file's header. A startup reconciliation would therefore be a
 * loop that fails on every boot, into a log nobody reads.
 *
 * On the editor's load there IS a credential, and better still there is a person:
 * the admin who opened the screen, whose authority is the right authority to make
 * the grant, and who is looking at the result. A failure becomes a line on a
 * screen in front of somebody who can act on it, instead of a silence.
 *
 * Sequential rather than concurrent. This is a handful of admins against one
 * warehouse, and the warehouse may be waking up.
 */
export async function reconcileAccess(input: {
  run: SqlRunner | null;
  store: AdminStore;
  emails: readonly string[];
  actor: string;
  telemetry: string;
  unavailable?: string;
}): Promise<AccessReport[]> {
  const reports: AccessReport[] = [];
  for (const email of input.emails) {
    reports.push({
      email: normalizeAdminEmail(email),
      results: await applyAccess({
        run: input.run,
        store: input.store,
        email,
        actor: input.actor,
        telemetry: input.telemetry,
        unavailable: input.unavailable,
      }),
    });
  }
  return reports;
}

/** How long one statement is waited on. A cold warehouse takes most of it. */
export const ACCESS_STATEMENT_TIMEOUT_MS = 40_000;

/**
 * The parts of the SQL Statement Execution API's answer this module reads.
 *
 * Declared rather than reached into as `any`, because two of these fields decide
 * whether a grant is reported as made or refused, and a rename upstream should
 * become a type error here rather than a statement silently reported as failed.
 */
interface StatementResponse {
  message?: string;
  status?: { state?: string; error?: { message?: string } };
  result?: { data_array?: string[][] };
}

/**
 * Run statements as the signed-in admin, over the SQL Statement Execution API.
 *
 * Same call shape as `statementExecutorFor` in access-verification.ts, with the
 * rows kept: this module has to READ `SHOW GRANTS` output, and that executor
 * reports only whether a statement succeeded.
 */
export function accessRunner(options: {
  host: string;
  token: string;
  warehouseId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SqlRunner {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ACCESS_STATEMENT_TIMEOUT_MS;
  return async (statement: string): Promise<SqlOutcome> => {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await call(`${options.host}/api/2.0/sql/statements`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          warehouse_id: options.warehouseId,
          statement,
          wait_timeout: '30s',
          on_wait_timeout: 'CANCEL',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      return {
        ok: false,
        message: timedOut
          ? `The SQL warehouse did not answer within ${timeoutMs} ms, so this did not complete.`
          : `The SQL warehouse could not be reached: ${(error as Error).message}`,
      };
    }
    const body = (await response.json().catch(() => ({}))) as StatementResponse;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: body.message ?? `Databricks answered HTTP ${response.status} with no message body.`,
      };
    }
    if (body.status?.state !== 'SUCCEEDED') {
      return {
        ok: false,
        message: body.status?.error?.message ?? `The statement ended in state ${body.status?.state ?? 'UNKNOWN'}.`,
      };
    }
    // `data_array` is absent for a statement that returns nothing, which every
    // GRANT does. An empty array rather than undefined, so a caller reading rows
    // never has to tell "no rows" from "no result set".
    const data = body.result?.data_array;
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  };
}
