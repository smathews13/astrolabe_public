/**
 * The half of "add an administrator" that is a Unity Catalog grant.
 *
 * The tests worth having here are about the three ways this can be dishonest,
 * because each of them has a version that looks like it works:
 *
 *   1. Reporting a grant that was refused. A half-granted target is not access,
 *      and a row saying somebody can read telemetry when they cannot sends
 *      somebody to debug an empty page that is working correctly.
 *   2. Revoking something this app did not grant. There is no undo. A person can
 *      hold `SELECT` on the billing tables because a platform team granted it for
 *      an unrelated reason, and removing an app admin must not take that away.
 *   3. Treating "could not check" as "does not have". Unknown is not evidence,
 *      and the safe reading of no evidence is to change nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAccess,
  BILLING_AUTHORITY_NOTE,
  BILLING_TABLES,
  grantFor,
  grantStatement,
  heldAlready,
  objectsFor,
  privilegesFor,
  readProvenance,
  reconcileAccess,
  revokeStatement,
  showGrantsStatement,
  telemetryDestination,
  withdrawAccess,
  type SqlOutcome,
  type SqlRunner,
} from './admin-access';
import { ADMIN_GRANTS_TABLE } from './admin-roles-schema';

const TELEMETRY = 'example_catalog.player_insights_telemetry';
const PERSON = 'analyst@example.com';

/** Just enough Lakebase to hold provenance rows, so the tests exercise the real SQL. */
function fakeStore() {
  const rows: Record<string, string>[] = [];
  return {
    rows,
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const values = params as string[];
      if (sql.startsWith(`INSERT INTO ${ADMIN_GRANTS_TABLE}`)) {
        const [email, target, object, privilege, provenance, actor] = values;
        const row = { email, target, object, privilege, provenance, actor };
        const at = rows.findIndex(
          (existing) => existing.email === email && existing.object === object && existing.privilege === privilege
        );
        if (at >= 0) rows[at] = row;
        else rows.push(row);
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }
      if (sql.startsWith('SELECT email, target, object, privilege, provenance')) {
        return Promise.resolve({ rows: rows.filter((row) => row.email === values[0]) as Record<string, unknown>[] });
      }
      if (sql.startsWith(`DELETE FROM ${ADMIN_GRANTS_TABLE}`)) {
        const [email, object, privilege] = values;
        const at = rows.findIndex(
          (row) => row.email === email && row.object === object && row.privilege === privilege
        );
        if (at >= 0) rows.splice(at, 1);
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
  };
}

function runner(behaviour: (statement: string) => SqlOutcome) {
  const seen: string[] = [];
  const run: SqlRunner = (statement) => {
    seen.push(statement);
    return Promise.resolve(behaviour(statement));
  };
  return { run, seen };
}

/** Nobody holds anything, and every grant lands. */
const grantsEverything = (statement: string): SqlOutcome =>
  statement.startsWith('SHOW GRANTS') ? { ok: true, rows: [] } : { ok: true, rows: [] };

/**
 * The person already holds every privilege asked about.
 *
 * `ALL PRIVILEGES` rather than a list, because `SHOW GRANTS` output does not name
 * the privilege the caller was asking after and a fixture that answered `SELECT`
 * to every question would report the traversal privileges as absent.
 */
function alreadyHoldsEverything(statement: string): SqlOutcome {
  if (statement.startsWith('SHOW GRANTS')) {
    return { ok: true, rows: [[PERSON, 'ALL PRIVILEGES', 'SCHEMA', TELEMETRY]] };
  }
  throw new Error(`nothing should have been granted, but this ran: ${statement}`);
}

describe('the telemetry destination', () => {
  it('takes a catalog and schema', () => {
    expect(telemetryDestination('example_catalog.telemetry')).toBe('example_catalog.telemetry');
  });

  it('treats an unset variable as nothing to grant rather than as a fault', () => {
    // The normal state on a customer target. Telemetry ingestion is billed, so a
    // customer opts into no charge and sets no destination.
    expect(telemetryDestination(undefined)).toBe('');
    expect(telemetryDestination('  ')).toBe('');
  });

  it('refuses a value that is not a schema instead of repairing it', () => {
    // A bare catalog and a three-part table both resolve to empty, so no GRANT is
    // ever aimed at an object the deployer did not name.
    expect(telemetryDestination('example_catalog')).toBe('');
    expect(telemetryDestination('example_catalog.telemetry.otel_logs')).toBe('');
  });
});

describe('what each target needs granted', () => {
  it('grants SELECT on the telemetry SCHEMA, not on the tables inside it', () => {
    // Load-bearing. The platform creates otel_logs, otel_spans and otel_metrics
    // itself, after the deploy. A grant enumerating them today would miss
    // whichever did not exist yet, and the admin would hold two of three with
    // nothing on screen saying which.
    const privileges = privilegesFor('telemetry', TELEMETRY);

    expect(privileges).toEqual([
      { kind: 'CATALOG', name: 'example_catalog', privilege: 'USE CATALOG' },
      { kind: 'SCHEMA', name: TELEMETRY, privilege: 'USE SCHEMA' },
      { kind: 'SCHEMA', name: TELEMETRY, privilege: 'SELECT' },
    ]);
  });

  it('needs nothing when no telemetry schema is configured', () => {
    expect(privilegesFor('telemetry', '')).toEqual([]);
  });

  it('grants traversal before the read, for both targets', () => {
    // Unity Catalog hides an object the caller cannot traverse, so SELECT without
    // USE SCHEMA produces a table that reads as absent rather than as forbidden.
    for (const privileges of [privilegesFor('telemetry', TELEMETRY), privilegesFor('billing', TELEMETRY)]) {
      expect(privileges[0].privilege).toBe('USE CATALOG');
      expect(privileges[1].privilege).toBe('USE SCHEMA');
    }
  });

  it('covers both billing tables the cost block reads', () => {
    const names = privilegesFor('billing', TELEMETRY).map((privilege) => privilege.name);

    for (const table of BILLING_TABLES) expect(names).toContain(table);
  });
});

describe('the statements', () => {
  it('quotes every identifier part, including the address', () => {
    const statement = grantStatement({ kind: 'SCHEMA', name: TELEMETRY, privilege: 'SELECT' }, PERSON);

    expect(statement).toBe('GRANT SELECT ON SCHEMA `example_catalog`.`player_insights_telemetry` TO `analyst@example.com`;');
  });

  it('revokes from, rather than to', () => {
    expect(revokeStatement({ kind: 'TABLE', name: 'system.billing.usage', privilege: 'SELECT' }, PERSON)).toBe(
      'REVOKE SELECT ON TABLE `system`.`billing`.`usage` FROM `analyst@example.com`;'
    );
  });

  it('asks what one principal holds on one object', () => {
    expect(showGrantsStatement({ kind: 'CATALOG', name: 'system', privilege: 'USE CATALOG' }, PERSON)).toBe(
      'SHOW GRANTS `analyst@example.com` ON CATALOG `system`'
    );
  });

  it('offers every statement a target needs, not only the one that failed', () => {
    // Same reasoning as tableGrant in access-verification.ts: the traversal
    // privileges are idempotent, any of them can be the absent one, and a reader
    // given a partial list runs it and finds the object still unreadable.
    const grant = grantFor('telemetry', TELEMETRY, PERSON);

    expect(grant.object).toBe(TELEMETRY);
    expect(grant.privilege).toBe('SELECT');
    expect(grant.statement.split('\n')).toHaveLength(3);
  });
});

describe('reading what somebody already holds', () => {
  it('finds the privilege wherever SHOW GRANTS puts it in the row', () => {
    const { run } = runner(() => ({ ok: true, rows: [['someone', 'SELECT', 'SCHEMA', 'a.b']] }));

    return expect(heldAlready(run, { kind: 'SCHEMA', name: 'a.b', privilege: 'SELECT' }, PERSON)).resolves.toBe(true);
  });

  it('counts ALL PRIVILEGES as holding it, because it is', () => {
    const { run } = runner(() => ({ ok: true, rows: [['someone', 'ALL PRIVILEGES', 'SCHEMA', 'a.b']] }));

    return expect(heldAlready(run, { kind: 'SCHEMA', name: 'a.b', privilege: 'SELECT' }, PERSON)).resolves.toBe(true);
  });

  it('answers null when the question could not be asked', () => {
    // Not false. The difference decides whether a later removal revokes.
    const { run } = runner(() => ({ ok: false, status: 403, message: 'PERMISSION_DENIED' }));

    return expect(heldAlready(run, { kind: 'SCHEMA', name: 'a.b', privilege: 'SELECT' }, PERSON)).resolves.toBeNull();
  });
});

describe('granting access alongside the role', () => {
  it('grants what is missing and records that this app is the reason', async () => {
    const store = fakeStore();
    const { run, seen } = runner(grantsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const telemetry = results.find((result) => result.target === 'telemetry');

    expect(telemetry?.state).toBe('granted');
    // The line says what the state word does not: this app is the reason the
    // access is there, so removing the person takes it back. Already-held carries
    // no line at all, and the two used to say almost the same thing twice.
    expect(telemetry?.summary).toBe('Granted just now by this app, so removing them takes it away again.');
    expect(telemetry?.grant).toBeNull();
    expect(seen.filter((statement) => statement.startsWith('GRANT'))).toHaveLength(
      privilegesFor('telemetry', TELEMETRY).length + privilegesFor('billing', TELEMETRY).length
    );
    expect(store.rows.every((row) => row.provenance === 'app-granted')).toBe(true);
  });

  it('is idempotent: a second run grants nothing and says so', async () => {
    const store = fakeStore();
    const { run } = runner(alreadyHoldsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });

    expect(results.map((result) => result.state)).toEqual(['already-held', 'already-held']);
    expect(store.rows.every((row) => row.provenance === 'pre-existing')).toBe(true);
  });

  it('records unknown, not app-granted, when the check could not be made', async () => {
    // The grant went through. Whether it was already there is unknowable, so the
    // removal path must never revoke it.
    const store = fakeStore();
    const { run } = runner((statement) =>
      statement.startsWith('SHOW GRANTS') ? { ok: false, status: 403, message: 'PERMISSION_DENIED' } : { ok: true, rows: [] }
    );

    await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });

    expect(store.rows.length).toBeGreaterThan(0);
    expect(store.rows.every((row) => row.provenance === 'unknown')).toBe(true);
  });

  it('reports a refused target as refused, with the statement somebody can run', async () => {
    const store = fakeStore();
    const { run } = runner((statement) =>
      statement.startsWith('SHOW GRANTS')
        ? { ok: true, rows: [] }
        : { ok: false, status: 403, message: 'PERMISSION_DENIED: User is not an owner of Schema' }
    );

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const telemetry = results.find((result) => result.target === 'telemetry');

    expect(telemetry?.state).toBe('refused');
    expect(telemetry?.summary).toContain('Access not granted.');
    expect(telemetry?.summary).toContain('PERMISSION_DENIED');
    // The object, the privilege, and a copyable statement. The app's existing
    // grant pattern, so this refusal reads the same as the ones on Connections
    // and on the Ops cost block.
    expect(telemetry?.grant?.object).toBe(TELEMETRY);
    expect(telemetry?.grant?.privilege).toBe('SELECT');
    expect(telemetry?.grant?.statement).toContain('GRANT SELECT ON SCHEMA');
  });

  it('says a refused billing grant needs an authority nobody here has', async () => {
    // The expected outcome rather than a surprise. Databricks documents access to
    // `system` as granted by somebody holding both the account admin and the
    // metastore admin role, and being a workspace admin is not enough. It is
    // attempted anyway, because a deployment whose app admins ARE metastore admins
    // exists, and telling those people to go and do a thing they can do from here
    // is its own defect.
    const store = fakeStore();
    const { run } = runner((statement) =>
      statement.startsWith('SHOW GRANTS') ? { ok: true, rows: [] } : { ok: false, status: 403, message: 'PERMISSION_DENIED' }
    );

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });

    expect(results.find((result) => result.target === 'billing')?.note).toBe(BILLING_AUTHORITY_NOTE);
    expect(results.find((result) => result.target === 'telemetry')?.note).toBe('');
  });

  it('reports an unconfigured telemetry schema as nothing to grant, and still tries billing', async () => {
    const store = fakeStore();
    const { run, seen } = runner(grantsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: '' });

    expect(results.find((result) => result.target === 'telemetry')?.state).toBe('not-configured');
    expect(results.find((result) => result.target === 'billing')?.state).toBe('granted');
    expect(seen.some((statement) => statement.includes('player_insights_telemetry'))).toBe(false);
  });

  it('reports not-checked, never refused, when no statement could be run at all', async () => {
    // "Not checked" means not checked YET, everywhere in this app. A missing
    // warehouse is not a permission decision and must not read as one.
    const store = fakeStore();

    const results = await applyAccess({
      run: null,
      store,
      email: PERSON,
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
      unavailable: 'Not checked. No warehouse.',
    });

    expect(results.map((result) => result.state)).toEqual(['not-checked', 'not-checked']);
    expect(results.every((result) => result.grant === null)).toBe(true);
    expect(store.rows).toHaveLength(0);
  });
});

describe('taking access back', () => {
  it('revokes what this app granted', async () => {
    const store = fakeStore();
    const granting = runner(grantsEverything);
    await applyAccess({
      run: granting.run,
      store,
      email: PERSON,
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
    });

    const revoking = runner(() => ({ ok: true, rows: [] }));
    const results = await withdrawAccess({ run: revoking.run, store, email: PERSON, telemetry: TELEMETRY });

    expect(results[0].state).toBe('granted');
    expect(results[0].summary).toBe('Access taken back.');
    expect(revoking.seen.every((statement) => statement.startsWith('REVOKE'))).toBe(true);
    // Everything that granted a READ is gone, and the claim goes with it, so the
    // app stops saying it granted something it did not.
    const left = await readProvenance(store, PERSON);
    expect(left.map((row) => row.privilege)).toEqual(['USE CATALOG', 'USE CATALOG']);
  });

  /**
   * The one privilege this app grants and keeps.
   *
   * `USE CATALOG` shows no data by itself: it lets somebody see INTO a catalog,
   * and without it Unity Catalog hides objects rather than refusing them. Revoking
   * it is the only revoke here that can break something nobody asked this app to
   * touch, because a data owner may have granted this person a table in the same
   * catalog in the meantime and that table would start reading as absent.
   */
  it('keeps the permission to see into a catalog, and says why', async () => {
    const store = fakeStore();
    await applyAccess({
      run: runner(grantsEverything).run,
      store,
      email: PERSON,
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
    });

    const revoking = runner(() => ({ ok: true, rows: [] }));
    const results = await withdrawAccess({ run: revoking.run, store, email: PERSON, telemetry: TELEMETRY });

    expect(revoking.seen.some((statement) => statement.startsWith('REVOKE USE CATALOG'))).toBe(false);
    expect(revoking.seen.some((statement) => statement.startsWith('REVOKE SELECT'))).toBe(true);
    expect(results[0].note).toContain('see into the catalog was left in place');
    expect(results[0].note).toContain('shows no data on its own');
  });

  it('leaves a privilege the person already held, and says so', async () => {
    // The case this whole mechanism exists for. Somebody may hold SELECT on the
    // billing tables because a platform team granted it for an unrelated reason,
    // and there is no undo for taking it away.
    const store = fakeStore();
    const granting = runner(alreadyHoldsEverything);
    await applyAccess({
      run: granting.run,
      store,
      email: PERSON,
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
    });

    const revoking = runner(() => {
      throw new Error('nothing should have been revoked');
    });
    const results = await withdrawAccess({ run: revoking.run, store, email: PERSON, telemetry: TELEMETRY });

    expect(revoking.seen).toHaveLength(0);
    expect(results[0].summary).toBe('No read access to take away.');
    expect(results[0].note).toContain('Access this app did not grant was left in place.');
    // The rows stay, because they are the record of the decision not to revoke.
    await expect(readProvenance(store, PERSON)).resolves.not.toHaveLength(0);
  });

  it('leaves a privilege whose provenance could not be established', async () => {
    const store = fakeStore();
    const granting = runner((statement) =>
      statement.startsWith('SHOW GRANTS') ? { ok: false, message: 'PERMISSION_DENIED' } : { ok: true, rows: [] }
    );
    await applyAccess({
      run: granting.run,
      store,
      email: PERSON,
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
    });

    const revoking = runner(() => {
      throw new Error('unknown provenance must never be revoked');
    });
    await withdrawAccess({ run: revoking.run, store, email: PERSON, telemetry: TELEMETRY });

    expect(revoking.seen).toHaveLength(0);
  });

  it('keeps the claim when a revoke is refused, and offers the statement', async () => {
    const store = fakeStore();
    const granting = runner(grantsEverything);
    await applyAccess({
      run: granting.run,
      store,
      email: PERSON,
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
    });

    const revoking = runner(() => ({ ok: false, status: 403, message: 'PERMISSION_DENIED' }));
    const results = await withdrawAccess({ run: revoking.run, store, email: PERSON, telemetry: TELEMETRY });

    expect(results[0].state).toBe('refused');
    expect(results[0].grant?.statement).toContain('REVOKE');
    // Still claimed, because the privilege is still there.
    await expect(readProvenance(store, PERSON)).resolves.not.toHaveLength(0);
  });

  it('revokes nothing when the record of what it granted cannot be read', async () => {
    const unreadable = {
      query(text: string) {
        if (text.includes('SELECT email, target')) return Promise.reject(new Error('Lakebase is not answering'));
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    };
    const revoking = runner(() => {
      throw new Error('nothing should have been revoked');
    });

    const results = await withdrawAccess({ run: revoking.run, store: unreadable, email: PERSON, telemetry: TELEMETRY });

    expect(results[0].state).toBe('not-checked');
    expect(revoking.seen).toHaveLength(0);
  });
});

describe('reconciling every administrator', () => {
  it('grants to whoever was missing it, however they got the role', async () => {
    // Seed admins come from bundle configuration and never pass through the Add
    // button, so without this they hold the role and none of the access.
    const store = fakeStore();
    const { run } = runner(grantsEverything);

    const reports = await reconcileAccess({
      run,
      store,
      emails: ['seeded@example.com', 'added@example.com'],
      actor: 'boss@example.com',
      telemetry: TELEMETRY,
    });

    expect(reports.map((report) => report.email)).toEqual(['seeded@example.com', 'added@example.com']);
    expect(reports.every((report) => report.results.every((result) => result.state === 'granted'))).toBe(true);
  });

  it('changes nothing on a second pass', async () => {
    const store = fakeStore();
    const held = new Set<string>();
    const { run } = runner((statement) => {
      if (statement.startsWith('SHOW GRANTS')) {
        const object = /ON \w+ (.+)$/.exec(statement)?.[1] ?? '';
        return { ok: true, rows: held.has(object) ? [['x', 'SELECT'], ['x', 'USE CATALOG'], ['x', 'USE SCHEMA']] : [] };
      }
      held.add(/ON \w+ (\S+) TO/.exec(statement)?.[1] ?? '');
      return { ok: true, rows: [] };
    });

    await reconcileAccess({ run, store, emails: [PERSON], actor: 'boss@example.com', telemetry: TELEMETRY });
    const second = await reconcileAccess({ run, store, emails: [PERSON], actor: 'boss@example.com', telemetry: TELEMETRY });

    expect(second[0].results.every((result) => result.state === 'already-held')).toBe(true);
  });
});

describe('the copy', () => {
  it('uses no em dash anywhere', async () => {
    const store = fakeStore();
    const { run } = runner((statement) =>
      statement.startsWith('SHOW GRANTS') ? { ok: true, rows: [] } : { ok: false, message: 'PERMISSION_DENIED' }
    );

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const words = [...results.map((result) => `${result.summary} ${result.note}`), BILLING_AUTHORITY_NOTE].join(' ');

    expect(words).not.toContain('\u2014');
  });

  it('says what a row means in one short line, per state', async () => {
    // The design note asks for a row whose state is readable at a glance without
    // hovering. It used to be asserted as "every state has a sentence", which is
    // what produced the same sentence under every target of every person. What has
    // to hold is that a row is LEGIBLE: it is labelled, it says what the access is
    // for, and it either names its objects or explains why it names none.
    const store = fakeStore();
    const { run } = runner(grantsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });

    for (const result of results) {
      expect(result.label.length).toBeGreaterThan(0);
      expect(result.purpose.length).toBeGreaterThan(0);
      expect(result.objects.length > 0 || result.summary.length > 0).toBe(true);
      expect(result.summary.length).toBeLessThan(200);
    }
  });
});

describe('a row names the objects the access is on', () => {
  /**
   * Sam's report: "showing this in the deployment is useless I should be able to
   * see what these schemas are". The row said "Telemetry schema / Already held"
   * and named nothing, so the access could not be checked and the data could not
   * be looked at.
   */
  it('names the configured telemetry destination, and only it', async () => {
    const store = fakeStore();
    const { run } = runner(alreadyHoldsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const telemetry = results.find((result) => result.target === 'telemetry');

    expect(telemetry?.objects).toEqual([{ name: TELEMETRY, kind: 'schema' }]);
  });

  /**
   * The traversal privileges are granted, recorded and re-run in the copyable
   * statement, and they are deliberately NOT named here. Four objects under one row,
   * three of them answering a question nobody asked, buries the one that matters.
   */
  it('leaves the traversal privileges out of the names while still granting them', async () => {
    const store = fakeStore();
    const { run, seen } = runner(grantsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const [catalog] = TELEMETRY.split('.');

    expect(results.find((result) => result.target === 'telemetry')?.objects.map((object) => object.name)).toEqual([
      TELEMETRY,
    ]);
    expect(seen).toContain(`GRANT USE CATALOG ON CATALOG \`${catalog}\` TO \`${PERSON}\`;`);
  });

  it('names both billing tables, as tables', async () => {
    const store = fakeStore();
    const { run } = runner(alreadyHoldsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const billing = results.find((result) => result.target === 'billing');

    expect(billing?.objects).toEqual(BILLING_TABLES.map((name) => ({ name, kind: 'table' })));
  });

  it('says what each access is for, which is why the row is worth having', async () => {
    const store = fakeStore();
    const { run } = runner(alreadyHoldsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });

    expect(results.find((result) => result.target === 'telemetry')?.purpose).toBe('What the Ops health block reads.');
    expect(results.find((result) => result.target === 'billing')?.purpose).toBe('What the Ops cost block reads.');
  });

  /**
   * The customer-target case, and the one where inventing a name would be worst:
   * a placeholder catalog rendered as though it were real, in a published tree.
   */
  it('names nothing and explains itself when no telemetry destination is set', async () => {
    const store = fakeStore();
    const { run } = runner(grantsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: '' });
    const telemetry = results.find((result) => result.target === 'telemetry');

    expect(telemetry?.state).toBe('not-configured');
    expect(telemetry?.objects).toEqual([]);
    expect(telemetry?.summary).toContain('no app telemetry');
    // Not a fault. A deployment that opted out of a billed ingestion is working.
    expect(telemetry?.summary).toContain('Nothing is wrong.');
  });

  /**
   * Billing is still named on the deployment where the app can never grant it,
   * because whose authority is needed and what the object is are two facts, and
   * the person going to ask a metastore admin has to be able to say which tables.
   */
  it('names the billing tables even when the grant is refused, and keeps the statements', async () => {
    const store = fakeStore();
    // Nobody holds anything, and Unity Catalog refuses every grant aimed at
    // `system`, which is what a deployment whose admins are not metastore admins
    // actually does.
    const { run } = runner((statement) =>
      statement.startsWith('GRANT') && statement.includes('system')
        ? { ok: false, status: 403, message: 'PERMISSION_DENIED' }
        : { ok: true, rows: [] }
    );

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });
    const billing = results.find((result) => result.target === 'billing');

    expect(billing?.state).toBe('refused');
    expect(billing?.objects.map((object) => object.name)).toEqual([...BILLING_TABLES]);
    expect(billing?.note).toBe(BILLING_AUTHORITY_NOTE);
    // Every statement the target needs, not just the one that was refused first.
    // The loop stops at the first refusal, so the app has attempted less than this
    // block re-runs, and that is deliberate: the person running it by hand should
    // not have to discover the next refusal one statement at a time.
    expect(billing?.grant?.statement).toBe(grantFor('billing', TELEMETRY, PERSON).statement);
    // Backtick-quoted per part, which is why this is not a substring check on the
    // dotted name.
    for (const table of BILLING_TABLES) {
      const quoted = table
        .split('.')
        .map((part) => `\`${part}\``)
        .join('.');
      expect(billing?.grant?.statement).toContain(quoted);
    }
  });

  /**
   * The state that carries no line, and the reason the card stopped repeating
   * itself. Already held plus a name is the whole fact.
   */
  it('carries no explanatory line for access that was already held', async () => {
    const store = fakeStore();
    const { run } = runner(alreadyHoldsEverything);

    const results = await applyAccess({ run, store, email: PERSON, actor: 'boss@example.com', telemetry: TELEMETRY });

    expect(results.map((result) => result.state)).toEqual(['already-held', 'already-held']);
    expect(results.map((result) => result.summary)).toEqual(['', '']);
  });

  it('never puts a real catalog name in this repository', () => {
    // The names come from configuration at runtime. `objectsFor` returns whatever
    // it is handed for telemetry and a Databricks-managed catalog for billing, and
    // neither is a literal anybody's workspace could be identified from.
    expect(objectsFor('telemetry', 'somebody_elses_catalog.their_schema')).toEqual([
      { name: 'somebody_elses_catalog.their_schema', kind: 'schema' },
    ]);
    expect(objectsFor('billing', '').every((object) => object.name.startsWith('system.billing.'))).toBe(true);
  });
});
