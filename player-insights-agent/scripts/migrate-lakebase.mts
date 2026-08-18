#!/usr/bin/env -S npx tsx
/**
 * The schema versions, as an explicit step rather than a side effect of booting.
 *
 *   npm run migrate:lakebase -- --app <app-name> --profile <profile>              # verify
 *   npm run migrate:lakebase -- --app <app-name> --profile <profile> --apply
 *   npm run migrate:lakebase -- --app <app-name> --profile <profile> --rollback-to 2
 *
 * Exit codes, because this is meant to be called by something that gates on them:
 *   0  the schema is at the newest version this build knows about
 *   1  the schema is BEHIND, or a migration or rollback failed
 *   2  the request could not be carried out at all (bad arguments, no connection)
 *
 * ── WHY `--verify` IS THE DEFAULT, WHICH IS THE WHOLE DESIGN ──
 *
 * The obvious deploy step applies the DDL from the release. In this deployment
 * that is actively harmful, and the reason is ownership. Postgres checks
 * ownership of a table BEFORE it decides an `ALTER ... IF NOT EXISTS` is a no-op,
 * and ownership cannot be handed over afterwards: `ALTER ... OWNER TO` needs
 * `SET ROLE` on the target and Lakebase does not grant a person that over a
 * service principal. So a table created by a HUMAN running a release script is a
 * table the app can never maintain, for as long as it exists, and the only remedy
 * is to drop it. That has already cost this repository a release; see
 * `scripts/check-db-ownership.mjs`, which exists because of it.
 *
 * So the roles are split, and the split is the point:
 *
 *   - The APP applies, as itself, through the same runner. It owns its schema, so
 *     everything it creates is something it can maintain.
 *   - The RELEASE verifies. It reads `schema_version` and fails if the schema is
 *     behind what the build expects, which is the property the old boot-time DDL
 *     could not give at all: a release could promote a build whose schema change
 *     had silently never landed, and nothing would say so until a route failed
 *     with `undefined_column`.
 *
 * `--apply` is still here and is safe by construction rather than by convention:
 * the runner asks who owns the schema first and refuses when the connecting role
 * holds none of the owner's rights. Run as yourself against the deployed branch,
 * it declines and says why. Run against a branch of your own, it applies. To
 * apply as the app from automation, connect as the app: set
 * `PLAYER_INSIGHTS_MIGRATE_PG_USER` to its client id and
 * `PLAYER_INSIGHTS_MIGRATE_PG_PASSWORD` to an OAuth token minted for it.
 *
 * ── THE RELEASE HOOK, FOR WHOEVER OWNS `bundle/app-release.sh` ──
 *
 * One line, and it belongs AFTER the app deploy has finished and the new revision
 * is serving — not before. The app is what applies the migrations, so asking
 * before it has started would report the previous build's schema and fail every
 * release that contained a schema change:
 *
 *     ( cd player-insights-agent && npm run migrate:lakebase -- \
 *         --app "$APP_NAME" --profile "$PROFILE" )
 *
 * `--verify` is the default; do not pass `--apply` from a release script. What
 * the exit codes must do:
 *
 *   0  proceed. The schema is at the version the deployed build expects.
 *   1  FAIL THE RELEASE. The app is serving a build whose schema change did not
 *      land, which is the failure this step exists to catch: routes reading the
 *      new columns answer `undefined_column`, which is also what a missing GRANT
 *      looks like, so it gets diagnosed as the wrong thing. The remedy is in the
 *      app's own logs, on the lines beginning `[migrate]`.
 *   2  FAIL THE RELEASE, but as a broken check rather than a schema finding —
 *      arguments, credentials or the Lakebase lookup. Do not treat it as a pass.
 *
 * Nothing about this step is destructive and it holds no lock, so it is safe to
 * re-run and safe to run against a deployment somebody else is using. If it has
 * to be skipped in a hurry, skipping it leaves exactly the situation that existed
 * before it was written; it does not break a release that would otherwise work.
 *
 * Everything else is discovered from the app, so there is nothing to keep in step
 * by hand.
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { MIGRATIONS } from '../server/routes/insights-routes.ts';
import { readAppliedVersions, rollbackTo, runMigrations } from '../server/lib/migration-runner.ts';
import type { LakebaseReader } from '../server/lib/lakebase-store.ts';

function arg(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? '' : (process.argv[at + 1] ?? '');
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const APP = arg('app');
const PROFILE = arg('profile');
const ROLLBACK_TO = arg('rollback-to');
const APPLY = flag('apply');

if (!APP || !PROFILE) {
  console.error(
    'usage: npm run migrate:lakebase -- --app <app-name> --profile <profile> [--apply | --rollback-to <version>]'
  );
  process.exit(2);
}
if (APPLY && ROLLBACK_TO) {
  console.error('--apply and --rollback-to ask for opposite things. Pick one.');
  process.exit(2);
}

function cli(args: string[]): any {
  return JSON.parse(execFileSync('databricks', [...args, '--profile', PROFILE, '-o', 'json'], { encoding: 'utf8' }));
}

/**
 * The schema the app creates, read from its own migration list.
 *
 * Parsed rather than configured, for the same reason `check-db-ownership.mjs`
 * parses it: a second copy of this name is a way for the release to grant, check
 * and migrate a schema the app does not create, after which every route serves
 * nothing and still answers HTTP 200.
 */
function appSchema(): string {
  const found = MIGRATIONS.flatMap((migration) =>
    migration.statements.flatMap((statement) => [
      ...statement.matchAll(/CREATE SCHEMA IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g),
    ])
  ).map((match) => match[1]);
  const distinct = [...new Set(found)];
  if (distinct.length !== 1) {
    console.error(`expected exactly one schema in the app's migrations, found ${distinct.length}`);
    process.exit(2);
  }
  return distinct[0];
}

async function main(): Promise<number> {
  const app = cli(['apps', 'get', APP]);
  const postgres = (app.resources ?? []).map((resource: any) => resource.postgres).find(Boolean);
  if (!postgres) {
    // Not a failure. An app with no Postgres resource stores nothing, and
    // reporting a schema problem against it would be an invented finding.
    console.log(`SKIPPED: ${APP} has no attached postgres resource, so it has no schema to migrate.`);
    return 0;
  }

  const branch = postgres.branch;
  const databaseId = String(postgres.database ?? '')
    .split('/')
    .pop();
  const host = cli(['postgres', 'list-endpoints', branch])?.[0]?.status?.hosts?.host;
  const database = (cli(['postgres', 'list-databases', branch]) ?? []).find(
    (candidate: any) => candidate.database_id === databaseId
  )?.status?.postgres_database;
  if (!host || !database) {
    console.error(`could not resolve the Lakebase connection for ${APP} (host or database missing).`);
    return 2;
  }

  const user = process.env.PLAYER_INSIGHTS_MIGRATE_PG_USER || cli(['current-user', 'me']).userName;
  const password =
    process.env.PLAYER_INSIGHTS_MIGRATE_PG_PASSWORD ||
    JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', PROFILE], { encoding: 'utf8' })).access_token;
  if (!user || !password) {
    console.error('could not establish who to connect to Postgres as.');
    return 2;
  }

  const schema = appSchema();
  const client = new pg.Client({
    host,
    port: 5432,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // The runner takes the same narrow shape the server hands it. No pool, so
  // `withoutReadTimeout` takes its fallback path and runs the DDL on this one
  // connection — which is correct here: a single-connection client has no
  // borrowed session to have left a statement timeout on.
  const reader: LakebaseReader = {
    lakebase: {
      query: (text: string, params?: unknown[]) =>
        client.query(text, params as any[]).then((result) => ({ rows: result.rows as Record<string, unknown>[] })),
    },
  };

  console.log(`app        ${APP}`);
  console.log(`database   ${database} on ${host}`);
  console.log(`connected  ${user}`);
  console.log(`schema     ${schema}`);
  console.log(`build has  version(s) ${MIGRATIONS.map((migration) => migration.version).join(', ')}`);

  try {
    if (ROLLBACK_TO) {
      const target = Number(ROLLBACK_TO);
      if (!Number.isInteger(target) || target < 0) {
        console.error(`--rollback-to takes a whole version number, not "${ROLLBACK_TO}".`);
        return 2;
      }
      const outcome = await rollbackTo(reader, target, { schema, migrations: MIGRATIONS });
      if (!outcome.ok) {
        console.error(`ROLLBACK INCOMPLETE: ${outcome.blocked}`);
        console.error(`Reverted ${outcome.reverted.join(', ') || 'nothing'}; schema is at ${outcome.versionAfter}.`);
        return 1;
      }
      console.log(`ok: reverted ${outcome.reverted.join(', ') || 'nothing'}; schema is at ${outcome.versionAfter}.`);
      return 0;
    }

    const outcome = await runMigrations(reader, {
      schema,
      migrations: MIGRATIONS,
      mode: APPLY ? 'apply' : 'verify',
      // Recorded in `schema_version.applied_by`, so an operator can tell a
      // deliberate deploy step from the app's own boot-time fallback.
      appliedBy: 'deploy step',
    });

    if (outcome.ok) {
      console.log(`ok: schema is at version ${outcome.versionAfter}.`);
      return 0;
    }

    if (!APPLY) {
      console.error(
        `\nSCHEMA BEHIND: version(s) ${outcome.pending.join(', ')} are not applied. Nothing was changed, because ` +
          `this was a verification.\n` +
          `\nThe app applies its own migrations as its own Postgres role, which is the only role that can own the\n` +
          `objects it has to maintain. So this usually means the new build has not started yet, or it started and\n` +
          `its migration run failed -- check the app logs for lines beginning [migrate] or [lakebase].\n` +
          `\nDo NOT re-run this with --apply as yourself against a deployed branch. Anything it created would be\n` +
          `owned by you and refused to the app forever; see scripts/check-db-ownership.mjs.`
      );
      return 1;
    }

    console.error(`\nMIGRATION FAILED: version(s) ${outcome.pending.join(', ')} are not applied.`);
    if (outcome.blocked) console.error(outcome.blocked);
    for (const attempt of outcome.attempts) {
      for (const failure of attempt.failures.filter((candidate) => !candidate.satisfied)) {
        console.error(`  v${attempt.version} ${failure.label}: ${failure.message}`);
      }
    }
    // Said explicitly, because the useful next question is what the database is
    // at now rather than what this run tried to do.
    const applied = await readAppliedVersions(reader, schema);
    console.error(`\nRecorded versions: ${applied === null ? 'could not be read' : applied.join(', ') || 'none'}.`);
    return 1;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error((error as Error).message ?? error);
    process.exit(2);
  });
