/**
 * The roster: who this deployment knows, and what each of them may open.
 *
 * DRAWN ONLY FOR THE SUPER ADMIN, AND THAT IS NOT THE PERMISSION. `/api/users`
 * refuses a plain administrator with 403 whatever this component does. Not drawing
 * it is why an administrator does not meet a panel every control on which the server
 * would refuse.
 *
 * WHAT MAY BE DONE TO A ROW COMES FROM THE SERVER, never from a rule written here.
 * Each row arrives with the roles it may be changed to and whether it may be
 * removed, because the control on screen and the refusal on the route have to be one
 * rule rather than two implementations of one. A menu offering a change the route
 * would refuse is the failure that shape prevents.
 *
 * A PROMOTION IS TWO FACTS AND THE SECOND ONE CAN FAIL. The role is a row in
 * Lakebase. The access is a pair of Unity Catalog grants, on the telemetry schema
 * and the billing tables, which are what Monitoring and Ops read -- and an admin
 * without them opens the Ops tab on errors. The app cannot make the grant when the
 * acting super admin has no authority over the object, so the statement goes on
 * screen for somebody who has, in the same copyable panel Connections and the
 * administrator list already use.
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from './ui';
import { CopyableCommand } from './AdminListEditor';
import {
  accessOwed,
  canSubmit,
  originLabel,
  roleWord,
  rosterSummary,
  rowLocked,
  setOn,
  stepsDownFrom,
  type RosterEntry,
} from './user-roster';
import {
  ASSIGNABLE_ROLES,
  type Role,
  type RosterMutationPayload,
  type RosterPayload,
} from '../../shared/user-roster-contract';

/**
 * One row's role control, or the line saying why there is none.
 *
 * ABSENT RATHER THAN DISABLED, which is the decision this app already made for the
 * navigation: a greyed control a reader can never enable is a permanent invitation
 * to ask why. The line in its place says what to change instead.
 *
 * A native select rather than a styled menu. The list is three items that never
 * grows, it is reachable by keyboard without any code of ours, and a role control
 * that traps focus on the one screen that changes permissions is worse than a plain
 * one.
 */
function RoleControl({
  entry,
  payload,
  busy,
  onChange,
}: {
  entry: RosterEntry;
  payload: RosterMutationPayload;
  busy: boolean;
  onChange: (entry: RosterEntry, role: Role) => void;
}) {
  const locked = rowLocked(entry, payload);
  if (entry.assignable.length === 0) {
    return (<p className="roster-row-locked">
        {roleWord(entry.role)}
        {locked ? <span className="roster-row-locked-why">{locked}</span> : null}
      </p>
    );
  }
  return (<select
      className="roster-role-select"
      value={entry.role}
      disabled={busy}
      aria-label={`Role for ${entry.email}`}
      onChange={(event) => onChange(entry, event.target.value as Role)}
    >
      {/* The role held is in the list and is the selected option, so the control
          reads as the row's current state rather than as an empty prompt. It is
          never in `assignable`, because setting a role somebody already holds is
          refused, so it is added here and cannot be chosen twice. */}
      <option value={entry.role}>{roleWord(entry.role)}</option>
      {ASSIGNABLE_ROLES.filter((role) => entry.assignable.includes(role)).map((role) => (<option key={role} value={role}>
          {roleWord(role)}
        </option>
      ))}
    </select>
  );
}

/**
 * The rows, as a function of the payload and nothing else.
 *
 * Split from the editor below so they can be rendered in a test without a fetch or
 * an effect. That matters more here than it usually does: the claims worth defending
 * are about which controls a row offers in each state, and asserting them against
 * the source of a component nobody rendered is how this repository has shipped
 * screens that were wrong while every test passed.
 */
export function RosterRows({
  payload,
  busy,
  onChange,
  onRemove,
}: {
  payload: RosterMutationPayload;
  busy: boolean;
  onChange: (entry: RosterEntry, role: Role) => void;
  onRemove: (entry: RosterEntry) => void;
}) {
  return (<>
      <p className="admin-list-note">{rosterSummary(payload)}</p>

      {/* The way back into a deployment nobody can administer. Present only when
          nobody can act at all, which is the one state where there is nobody to
          withhold it from. */}
      {payload.recoveryStatement ? (<CopyableCommand command={payload.recoveryStatement} label="Appoint a super admin" />
      ) : null}

      {payload.pendingSchemaStatement ? (<CopyableCommand command={payload.pendingSchemaStatement} label="Add the role column" />
      ) : null}

      <ul className="admin-list">
        {payload.entries.map((entry) => (<li key={entry.email} className="admin-row">
            <div className="admin-row-head">
              <div className="admin-row-who">
                <p className="admin-row-email">
                  {entry.email}
                  {entry.isYou ? <span className="admin-row-you">You</span> : null}
                </p>
                {originLabel(entry) ? (<p className="admin-row-origin">
                    {originLabel(entry)}
                    {setOn(entry) ? ` on ${setOn(entry)}` : ''}
                  </p>
                ) : null}
              </div>
              <div className="roster-row-controls">
                <RoleControl entry={entry} payload={payload} busy={busy} onChange={onChange} />
                {entry.canRemove ? (<Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRemove(entry)}
                    aria-label={`Remove ${entry.email}`}
                  >
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function UserRoleEditor() {
  const [payload, setPayload] = useState<RosterMutationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [draftRole, setDraftRole] = useState<Role>('admin');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');
  const [owed, setOwed] = useState<string[]>([]);

  /**
   * A pure read, and only one call.
   *
   * Unlike the administrator list beside it, this does NOT reconcile access on load.
   * Reconciling makes Unity Catalog grants, that list already does it on every open,
   * and doing it twice on one page would run the same statements twice and write two
   * audit rows for one page load.
   */
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/users');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // The GET carries no access state, because it makes no grants. Defaulted to
      // empty here rather than on the server, where empty would read as "no access"
      // instead of "this call did not look".
      const read = (await response.json()) as RosterPayload;
      setPayload({ ...read, access: [] });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** One write path, so an add and a change cannot report their outcome differently. */
  async function write(request: { url: string; method: string; body: unknown; said: string }) {
    setBusy(true);
    setWriteError('');
    setNotice('');
    setOwed([]);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const body = (await response.json()) as RosterMutationPayload & { detail?: string };
      if (!response.ok) {
        setWriteError(body.detail ?? 'Nothing changed.');
        return false;
      }
      setPayload(body);
      setNotice(request.said);
      // The grants the role needs and did not get. Never left silent: the whole
      // reason this is on screen is that a new admin would otherwise meet an Ops tab
      // full of errors with nothing saying why.
      setOwed(accessOwed(body));
      return true;
    } catch (cause) {
      setWriteError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const email = draft.trim();
    const added = await write({
      url: '/api/users',
      method: 'POST',
      body: { email, role: draftRole },
      said: `${email} is now ${roleWord(draftRole).toLowerCase()}.`,
    });
    if (added) setDraft('');
  }

  return (<Card>
      <CardHeader>
        <CardTitle>Roles</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? <p className="admin-list-note">Reading the roster.</p> : null}

        {error ? (<p className="admin-list-note admin-list-error">
            The roster could not be read. Nobody has lost a role. Reload the page.
          </p>
        ) : null}

        {payload ? (<RosterRows
            payload={payload}
            busy={busy}
            onChange={(entry, role) =>
              void write({
                url: `/api/users/${encodeURIComponent(entry.email)}`,
                method: 'PATCH',
                body: { role },
                // The warning goes in the outcome line, before the panel this reader
                // is standing on disappears from under them.
                said: [`${entry.email} is now ${roleWord(role).toLowerCase()}.`, stepsDownFrom(entry, role)]
                  .filter(Boolean)
                  .join(' '),
              })
            }
            onRemove={(entry) =>
              void write({
                url: `/api/users/${encodeURIComponent(entry.email)}`,
                method: 'DELETE',
                body: {},
                said: `${entry.email} is off the roster.`,
              })
            }
          />
        ) : null}

        <div className="admin-add">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="name@example.com"
            aria-label="Email address to put on the roster"
          />
          <select
            className="roster-role-select"
            value={draftRole}
            disabled={busy}
            aria-label="Role to give them"
            onChange={(event) => setDraftRole(event.target.value as Role)}
          >
            {ASSIGNABLE_ROLES.map((role) => (<option key={role} value={role}>
                {roleWord(role)}
              </option>
            ))}
          </select>
          <Button disabled={!canSubmit(draft, busy)} onClick={() => void add()}>
            <UserPlus className="size-3.5" /> Add
          </Button>
        </div>

        {/* The statements somebody with authority runs. One panel each, because a
            reader copies them one at a time into a SQL editor. */}
        {owed.map((statement) => (<CopyableCommand key={statement} command={statement} label="Grant the access this role needs" />
        ))}

        {/* One live region for both, because they are the same slot on screen and two
            regions would be two announcements for one action. */}
        <p className="admin-list-note admin-list-outcome" role="status" aria-live="polite">
          {writeError || notice}
        </p>
      </CardContent>
    </Card>
  );
}
