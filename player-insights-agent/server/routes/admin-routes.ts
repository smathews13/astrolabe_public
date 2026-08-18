/**
 * The admin list, read and edited from the Settings gear.
 *
 * One endpoint family, `/api/admins`, and it is admin-only through the prefix
 * list in admin-roles.ts rather than through a guard written here. Nothing in
 * this file checks a role: the middleware has already refused a consumer with
 * 403 by the time a handler runs, and a second check here would be a second
 * place for the answer to be wrong.
 *
 * ADDING AN ADMIN IS TWO ACTIONS IN ONE, and this file is where they are kept
 * together. The role is a row in Lakebase. The access is a Unity Catalog grant on
 * the telemetry schema and the billing tables, made under the acting admin's own
 * forwarded token, because those are what the Monitoring and Ops tabs read and a
 * role without them opens two empty pages. See admin-access.ts for who runs the
 * grant and why it is not the app.
 *
 * THE TWO HALVES CAN DISAGREE, AND THE ANSWER IS NEVER TO HIDE IT. An admin
 * without authority over those objects can still add another admin: the role lands
 * and the grant is refused. Every response here therefore carries the access state
 * beside the list, the audit trail records the halves separately, and the editor
 * prints the statement somebody with authority can run. A 201 from this route means
 * "the role was granted", never "everything asked for happened".
 *
 * WHAT THE ROLE STILL DOES NOT GRANT is anybody's data. The two objects granted
 * here are records of the app's own operation. A question still runs under the
 * asker's own grants, and the app's data schema is untouched.
 */
import { z } from 'zod';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import {
  accessRunner,
  applyAccess,
  reconcileAccess,
  telemetryDestination,
  withdrawAccess,
  NO_TOKEN_REASON,
  NO_WAREHOUSE_REASON,
  type AccessResult,
  type SqlRunner,
} from '../lib/admin-access';
import {
  addAdmin,
  adminListPayload,
  invalidAdminEmail,
  normalizeAdminEmail,
  readAddedAdmins,
  recordAdminAction,
  removalRefusal,
  removeAdmin,
  REMOVAL_REFUSAL_DETAIL,
  seedAdminEmails,
  type AddedAdmin,
  type AdminAction,
  type AdminStore,
} from '../lib/admin-roles';
import type { AdminEditorPayload } from '../../shared/admin-contract';
import { forwardedUserToken } from './access-verification';
import { userEmail, type InsightsAppKit } from './insights-routes';
import type { Request } from 'express';

const AddBody = z.object({ email: z.string().trim().max(320) });

/**
 * The stored half, and whether it could be read.
 *
 * Two fields rather than an empty array on failure, because "no added admins"
 * and "the list could not be read" put the same zero rows on screen and have
 * different remedies. The editor says which it is; conflating them sends
 * somebody looking for a person who was never removed.
 */
async function readAdded(store: AdminStore): Promise<{ added: AddedAdmin[]; readable: boolean }> {
  try {
    return { added: await readAddedAdmins(store), readable: true };
  } catch (error) {
    console.warn('[admin] The stored admin list could not be read for the Settings editor:', (error as Error).message);
    return { added: [], readable: false };
  }
}

/**
 * A statement runner for this request, or the reason there is none.
 *
 * THE TOKEN IS THE SIGNED-IN ADMIN'S, never the app's. Absent, this returns no
 * runner rather than falling back to the app's own credential, and the editor
 * reports the access as not checked. That fallback is the one thing this file must
 * not do: it would make the app itself the grantor, which is the escalation
 * admin-access.ts exists to avoid.
 */
export function runnerFor(req: Request): { run: SqlRunner | null; unavailable: string } {
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  const warehouseId = (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? '').trim();
  const token = forwardedUserToken(req);
  if (!host) {
    return {
      run: null,
      unavailable:
        'Not checked. The app does not know its own workspace URL, so it cannot reach a SQL warehouse ' +
        'to make a grant.',
    };
  }
  if (!warehouseId) return { run: null, unavailable: NO_WAREHOUSE_REASON };
  if (!token) return { run: null, unavailable: NO_TOKEN_REASON };
  return { run: accessRunner({ host, token, warehouseId }), unavailable: '' };
}

/** The audit action one access result deserves. */
export function actionFor(result: AccessResult): AdminAction | null {
  if (result.state === 'granted') return 'access-granted';
  if (result.state === 'refused') return 'access-refused';
  return null;
}

export function setupAdminRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    /**
     * The whole list, seed rows and added rows, marked with what may be done to
     * each. Answers 200 with `addedAdminsReadable: false` when Lakebase is out,
     * because the seed rows are still true and still the deployment's
     * administrators, and a 503 would hide them behind the outage they survive.
     *
     * A PURE READ. It runs no `GRANT` and no `SHOW GRANTS`, so the list appears
     * without waiting on a warehouse that may be cold. The editor asks for the
     * access state separately, on the route below.
     */
    app.get('/api/admins', async (req, res) => {
      const { added, readable } = await readAdded(appkit.lakebase);
      const payload: AdminEditorPayload = {
        ...adminListPayload({
          seed: seedAdminEmails(),
          added,
          addedAdminsReadable: readable,
          reader: userEmail(req),
        }),
        access: [],
      };
      res.json(payload);
    });

    /**
     * Bring every administrator's access up to date with their role.
     *
     * A POST rather than part of the GET above, and that is not decoration: this
     * makes Unity Catalog grants. A read that quietly changed permissions would be
     * a surprising thing for a page load to do and an unpleasant thing to find in
     * an audit trail with no request of its own to point at.
     *
     * The editor calls it on load, which is the answer to "seed admins never pass
     * through the Add button". Idempotent, so calling it on every load costs a few
     * `SHOW GRANTS` reads and changes nothing once everybody is reconciled.
     */
    app.post('/api/admins/access', async (req, res) => {
      const actor = userEmail(req);
      const { added, readable } = await readAdded(appkit.lakebase);
      const list = adminListPayload({
        seed: seedAdminEmails(),
        added,
        addedAdminsReadable: readable,
        reader: actor,
      });
      const { run, unavailable } = runnerFor(req);
      const reports = await reconcileAccess({
        run,
        store: appkit.lakebase,
        emails: list.entries.map((entry) => entry.email),
        actor,
        telemetry: telemetryDestination(),
        unavailable,
      });
      // One row for the reconciliation as a whole rather than one per person per
      // target, which would fill the table on every page load. The per-person
      // rows are written when the grant is made, by applyAccess's callers.
      const changed = reports.filter((report) => report.results.some((result) => result.state === 'granted'));
      if (changed.length > 0) {
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'access-reconciled',
          subject: changed.map((report) => report.email).join(', '),
          detail:
            `${actor} opened the administrator settings, and ${changed.length} administrator` +
            `${changed.length === 1 ? '' : 's'} were missing access the role needs. It was granted under ` +
            `${actor}'s own authority.`,
        });
      }
      const payload: AdminEditorPayload = { ...list, access: reports };
      res.json(payload);
    });

    /**
     * Add one administrator, and grant them the access the role needs.
     *
     * 409 rather than 400 on an address already on the list: the request was
     * well formed and the address exists, what cannot be done is the thing
     * asked for. The same distinction the settings write route draws.
     *
     * THE ROLE IS WRITTEN FIRST AND KEPT EVEN IF THE GRANT IS REFUSED. The other
     * order was considered and is worse: an add that rolled back on a refused
     * grant would mean an admin without Unity Catalog authority could never
     * appoint anybody, on a deployment where appointing people is the one thing
     * the screen is for. So the role lands, the refusal is reported in the same
     * response, and the statement to fix it is on screen. 201 here means the role
     * was granted. It does not mean the access was.
     */
    app.post('/api/admins', async (req, res) => {
      const parsed = AddBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_admin_body', detail: 'Send one email address.' });
        return;
      }
      const invalid = invalidAdminEmail(parsed.data.email);
      if (invalid) {
        res.status(400).json({ error: 'invalid_admin_email', detail: invalid });
        return;
      }
      const email = normalizeAdminEmail(parsed.data.email);
      const actor = userEmail(req);
      if (seedAdminEmails().includes(email)) {
        res.status(409).json({
          error: 'already_an_admin',
          detail: 'That address is already an administrator, set at deployment.',
        });
        return;
      }
      try {
        const inserted = await addAdmin(appkit.lakebase, { email, addedBy: actor });
        if (!inserted) {
          res.status(409).json({ error: 'already_an_admin', detail: 'That address is already an administrator.' });
          return;
        }
        // After the write, so a row here means the change happened. Awaited, but
        // its own failure never fails the request: see recordAdminAction.
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'admin-added',
          subject: email,
          detail: `${actor} added ${email} as an administrator of this deployment.`,
        });
        const { run, unavailable } = runnerFor(req);
        const results = await applyAccess({
          run,
          store: appkit.lakebase,
          email,
          actor,
          telemetry: telemetryDestination(),
          unavailable,
        });
        for (const result of results) {
          const action = actionFor(result);
          if (!action) continue;
          await recordAdminAction(appkit.lakebase, {
            actor,
            action,
            subject: email,
            detail:
              action === 'access-granted'
                ? `${actor} granted ${email} read access to ${result.label.toLowerCase()} for this deployment.`
                : `${actor} could not grant ${email} read access to ${result.label.toLowerCase()}: ${result.summary}`,
          });
        }
        const readBack = await readAdded(appkit.lakebase);
        const payload: AdminEditorPayload = {
          ...adminListPayload({
            seed: seedAdminEmails(),
            added: readBack.added,
            addedAdminsReadable: readBack.readable,
            reader: actor,
          }),
          access: [{ email, results }],
        };
        res.status(201).json(payload);
      } catch (error) {
        console.error(`[admin] ${email} could not be added:`, (error as Error).message);
        res.status(503).json({
          error: 'admin_store_unavailable',
          detail:
            'The administrator was not added. The app stores added administrators in Lakebase, and it is ' +
            'not answering: reporting success here would leave a name on screen that no reload would keep.',
        });
      }
    });

    /**
     * Remove one administrator, or refuse and say why.
     *
     * Three refusals, and each is a different status because each is a different
     * kind of no: a seed row and the last administrator are 409, because the
     * request was well formed and the thing asked for cannot be done, and an
     * address that is not on the list is 404.
     *
     * The last-administrator refusal is checked against the list as READ, in
     * this request, rather than against what the screen believed. Two admins
     * removing each other at once would otherwise both pass a check made in the
     * browser and leave the deployment with nobody.
     *
     * THE ACCESS IS TAKEN BACK BEFORE THE ROW IS DELETED, because the record of
     * what this app granted is keyed by the address and the removal path needs to
     * read it. Only privileges this app can show it added are revoked; see
     * withdrawAccess.
     */
    app.delete('/api/admins/:email', async (req, res) => {
      const email = normalizeAdminEmail(req.params.email);
      const actor = userEmail(req);
      let added: AddedAdmin[];
      try {
        added = await readAddedAdmins(appkit.lakebase);
      } catch (error) {
        console.error('[admin] The stored admin list could not be read, so no removal was attempted:', (error as Error).message
        );
        res.status(503).json({
          error: 'admin_store_unavailable',
          detail:
            'Nobody was removed. The list could not be read, and removing an administrator without knowing ' +
            'who else is on it could leave this deployment with none.',
        });
        return;
      }
      const refusal = removalRefusal({ email, seed: seedAdminEmails(), added });
      if (refusal === 'not-found') {
        res.status(404).json({ error: 'no_such_admin', detail: REMOVAL_REFUSAL_DETAIL['not-found'] });
        return;
      }
      if (refusal) {
        res.status(409).json({ error: `removal_refused_${refusal.replace('-', '_')}`, detail: REMOVAL_REFUSAL_DETAIL[refusal] });
        return;
      }
      try {
        const { run, unavailable } = runnerFor(req);
        const results = await withdrawAccess({
          run,
          store: appkit.lakebase,
          email,
          telemetry: telemetryDestination(),
          unavailable,
        });
        await removeAdmin(appkit.lakebase, email);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'admin-removed',
          subject: email,
          detail: `${actor} removed ${email} as an administrator of this deployment.`,
        });
        for (const result of results) {
          if (result.state === 'not-configured') continue;
          await recordAdminAction(appkit.lakebase, {
            actor,
            action: 'access-revoked',
            subject: email,
            detail: `${actor} removed ${email}, and the access this app had granted them: ${result.summary}`,
          });
        }
        const readBack = await readAdded(appkit.lakebase);
        const payload: AdminEditorPayload = {
          ...adminListPayload({
            seed: seedAdminEmails(),
            added: readBack.added,
            addedAdminsReadable: readBack.readable,
            reader: actor,
          }),
          access: [{ email, results }],
        };
        res.json(payload);
      } catch (error) {
        console.error(`[admin] ${email} could not be removed:`, (error as Error).message);
        res.status(503).json({ error: 'admin_store_unavailable', detail: 'Nobody was removed.' });
      }
    });
  });
}
