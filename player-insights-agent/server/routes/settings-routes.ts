/**
 * What this deployment is connected to, and the narrow set of changes it can
 * actually make.
 *
 * The write route's job is mostly to REFUSE. Three of the five mutability tiers
 * cannot be changed by saving a value, and a caller that asks to make one active
 * is told so rather than quietly having its request downgraded to a note. The
 * refusal lives in the route rather than in the screen that calls it: a caller
 * that believed it had applied a customer's Genie space id would ship the same
 * silent misconfiguration this whole surface was built to expose.
 */
import type { Request } from 'express';
import { z } from 'zod';
import {
  agentEndpointCheck,
  extractConfigurationReport,
  extractPreflightReport,
  invokePreflight,
  userEmail,
  type InsightsAppKit,
  type PreflightCheck,
  type PreflightConfiguration,
  type PreflightReport,
} from './insights-routes';
import type { StoredSetting } from '../lib/app-settings';
import { lakebaseStorageCheck } from '../lib/lakebase-store';
import {
  appBuildSha,
  appEnvironment,
  classifyWrite,
  clearStoredSetting,
  readStoredSettings,
  resourceStates,
  settingsPayload,
  writeStoredSetting,
} from '../lib/app-settings';
import { resolveNotebookDeclaration } from '../lib/app-settings';
import { readAppFacts } from '../lib/app-metadata';
import { declaredTables, probeConnections } from '../lib/dependency-probes';
import { checkExperimentAsApp } from '../lib/experiment-probe';
import { forwardedUserToken } from './access-verification';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import {
  readPublishedDeclaration,
  type DeclarationRead,
} from '../lib/notebook-declaration-read';
import {
  compareDeclaration,
  type DeclarationComparison,
} from '../../shared/notebook-declaration';
import {
  addFault,
  addedConnectionEffect,
  readDeclaredConnections,
  removalImpact,
  restoreDeclaredConnection,
  withdrawDeclaredConnection,
  writeDeclaredConnection,
  type RemovalImpact,
  type StoredDeclaredConnection,
} from '../lib/declared-connections';
import type { ResourceKind } from '../../shared/deployment-config';

const WriteBody = z.object({
  value: z.string().trim().max(500),
  intent: z.enum(['active', 'intended']),
  note: z.string().trim().max(500).default(''),
});

/**
 * An asset somebody is adding to the list the agent may consider.
 *
 * `kind` is checked against the declarable set by `addFault` rather than by an
 * enum here, so there is ONE list of what may be added and the refusal text comes
 * from the same place whether the entry arrived from this route or from a notebook.
 */
const ConnectionBody = z.object({
  id: z.string().trim().max(80),
  label: z.string().trim().max(200).default(''),
  kind: z.string().trim().max(60),
  value: z.string().trim().max(500),
  note: z.string().trim().max(500).default(''),
});

/**
 * What asking the orchestrator produced: a report, or the reason there is none.
 *
 * Two fields rather than a nullable report, because "no report" has two causes
 * that a reader has to be able to tell apart. `answered` is about the endpoint,
 * `report` is about what it said.
 */
interface OrchestratorRead {
  report: PreflightReport | null;
  /** Whether the endpoint replied at all, however unhelpfully. */
  answered: boolean;
}

/**
 * What the endpoint said it is configured with, and nothing about health.
 *
 * The two checks the app can make for itself are real and are included. Every
 * other field is empty ON PURPOSE, and each empty one is read somewhere as "not
 * known" rather than as a value:
 *
 *   status 'unverified'  nothing behind the endpoint was probed on this path, so
 *                        the page must not imply a clean bill of health.
 *   checked_at ''        no dependency check ran, so there is no time to stamp.
 *   principal ''         the serving identity is only in the retired report. The
 *                        pane says it is unknown, which is true, instead of
 *                        printing the app's own principal as if it were the
 *                        endpoint's.
 *
 * `build_sha` is the exception and is lifted out of the configuration, because
 * the version does report it -- as one of its settings rather than as a field of
 * a report. Leaving it empty would have the app state that the served model
 * "predates the build stamp" while holding its stamp in the list beside it, and
 * that sentence tells an operator to re-log a model that needs nothing.
 */
function configurationOnlyReport(configuration: PreflightConfiguration[], endpointName: string): PreflightReport {
  const stamped = configuration.find((entry) => entry.key === 'build_sha');
  return {
    checked_at: '',
    status: 'unverified',
    principal: '',
    principal_resolved: false,
    table_source: '',
    build_sha: typeof stamped?.value === 'string' ? stamped.value : '',
    configuration,
    checks: [
      agentEndpointCheck(endpointName, {
        status: 'ok',
        detail: 'The app invoked the orchestrator and it reported its configuration.',
      }),
      lakebaseStorageCheck(),
    ],
    assumptions: [],
    counts: { ok: 0, failed: 0, unverified: 0 },
    // NOT 'agent', which is what this said for one release and is the whole
    // defect: downstream reads 'agent' as "something measured these values" and
    // suppresses the notice explaining that nothing did, so a page describing
    // nineteen unmeasured connections lost its only caveat and reported them as
    // agreeing. The endpoint answering is not the endpoint checking.
    source: 'configuration',
  };
}

/**
 * The orchestrator's report, with the two checks only the app can make.
 *
 * The same two `/api/preflight` adds, from the same exported helpers rather than
 * from a second copy of them: the endpoint cannot report on whether the app can
 * reach it, and it has no view of the app's own store. `source` is what tells a
 * reader whether anything behind the endpoint was measured at all, so it is set
 * from whether a report came back and never assumed.
 */
export async function readOrchestratorReport(appkit: InsightsAppKit): Promise<OrchestratorRead> {
  const endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '';
  let raw: unknown;
  try {
    raw = await invokePreflight(appkit);
  } catch (error) {
    console.warn('[settings] The orchestrator could not be asked what it is configured with:', (error as Error).message);
    return { report: null, answered: false };
  }
  const report = extractPreflightReport(raw);
  // Answered, with no report in it. `/api/preflight` has always drawn this
  // distinction and called it `preflight_retired`; this route collapsed it into
  // the unreachable case, so the page said the endpoint had not answered while
  // the endpoint was answering.
  //
  // A full report is the OLD shape, from when the endpoint ran dependency
  // checks. Every current version answers `preflight_retired` and carries its
  // configuration beside that word instead of inside a report -- so this branch
  // is now the normal path rather than the exception, and returning null here
  // threw away the only thing this route asked for. That is why every connection
  // read "configured, unmeasured" against a perfectly healthy endpoint: the pane
  // was comparing the app's environment with an empty list.
  if (!report) {
    const configuration = extractConfigurationReport(raw);
    if (configuration.length === 0) return { report: null, answered: true };
    return { report: configurationOnlyReport(configuration, endpointName), answered: true };
  }
  return {
    report: {
      ...report,
      checks: [
        agentEndpointCheck(endpointName, {
          status: 'ok',
          detail: 'The app invoked the orchestrator and it reported its configuration.',
        }),
        lakebaseStorageCheck(),
        ...report.checks,
      ],
      counts: { ok: 0, failed: 0, unverified: 0 },
      source: 'agent',
    },
    answered: true,
  };
}

export function setupSettingsRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    /**
     * Every connection, with what it was configured as, what the running system
     * used, and what somebody intends it to be.
     *
     * Answers 200 even when the orchestrator is unreachable. The payload then
     * says so (`orchestratorReported: false` plus a drift finding), because a
     * deployer arriving here to find out why nothing works is the main audience,
     * and a 503 would leave them with the app-side half they can already see.
     */
    app.get('/api/settings', async (req, res) => {
      const { report, answered } = await readOrchestratorReport(appkit);
      const stored = await readStoredSettings(appkit);
      const environment = appEnvironment();
      const payload = settingsPayload({
        report,
        endpointAnswered: answered,
        environment,
        stored,
        appBuildSha: appBuildSha(),
        // Asked separately, because `readStoredSettings` degrades an outage to
        // an empty map and that is indistinguishable from "nothing saved yet"
        // unless the state of the store is reported beside it. The same
        // distinction /api/storage draws, for the same reason.
        storeAvailable: await storeAnswers(appkit),
        // The app's own record: the host, the description, the compute and the
        // release. Read here rather than on its own route so the Build card
        // cannot end up describing one moment while the rows below it describe
        // another, which is the reason every other fact on this page arrives on
        // this payload too.
        app: await readAppFacts(),
      });
      const states = resourceStates({ report, environment, stored });
      res.json({
        ...payload,
        checks: await readReachability(req, { report, environment, stored }),
        // Assembled here rather than inside `settingsPayload` for the reason that
        // function's own comment gives: it is pure, and both of these need a round
        // trip. The notebook read also needs the request, because it is made as the
        // signed-in user.
        notebook: await readNotebook(req, appkit, report),
        connections: await readConnections(appkit, states),
      });
    });

    /**
     * Add an asset to the list the agent may consider.
     *
     * 201 carries `effect`, which says in one sentence that this granted nobody
     * anything. It is on the response rather than only in the client because a
     * caller that reported "connected" without it would be telling a customer the
     * opposite of what happened.
     */
    app.post('/api/settings/connections', async (req, res) => {
      const parsed = ConnectionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_connection_body', detail: parsed.error.message });
        return;
      }
      const fault = addFault(parsed.data);
      if (fault) {
        res.status(400).json({ error: 'connection_not_allowed', detail: fault });
        return;
      }
      try {
        const connection = await writeDeclaredConnection(appkit, {
          id: parsed.data.id,
          label: parsed.data.label || parsed.data.id,
          kind: parsed.data.kind as ResourceKind,
          value: parsed.data.value,
          note: parsed.data.note,
          origin: 'app',
          changedBy: userEmail(req),
        });
        res.status(201).json({ connection, effect: addedConnectionEffect() });
      } catch (error) {
        console.error('[connections] The connection could not be added:', (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail:
            'The connection was not added. The app stores these in Lakebase, and it is not ' +
            'answering: reporting success here would leave a row on screen that no restart would keep.',
        });
      }
    });

    /**
     * What withdrawing this connection would cost, without withdrawing it.
     *
     * A route of its own so the confirmation a reader sees is computed from the
     * stored row and the live configuration rather than from what the client
     * happens to be holding. The dangerous case is the one where the running model
     * is configured with the same value and withdrawal changes nothing about the
     * deployment, and a client-side guess would get that wrong.
     */
    app.get('/api/settings/connections/:id/impact', async (req, res) => {
      const connections = await readDeclaredConnections(appkit);
      const connection = connections.find((entry) => entry.id === req.params.id);
      if (!connection) {
        res.status(404).json({ error: 'no_such_connection', detail: 'Nothing is declared under that name.' });
        return;
      }
      res.json({ impact: await impactFor(appkit, connection) });
    });

    /**
     * Withdraw a connection, keeping the row so it can be put back.
     *
     * The impact is returned WITH the withdrawal as well as being available before
     * it, so a caller that skipped the preview still has to be handed what stopped
     * working rather than a bare success.
     */
    app.delete('/api/settings/connections/:id', async (req, res) => {
      try {
        const connections = await readDeclaredConnections(appkit);
        const connection = connections.find((entry) => entry.id === req.params.id);
        if (!connection || connection.state === 'withdrawn') {
          res.status(404).json({
            error: 'no_such_connection',
            detail: connection
              ? 'That connection is already withdrawn.'
              : 'Nothing is declared under that name.',
          });
          return;
        }
        const impact = await impactFor(appkit, connection);
        const withdrawn = await withdrawDeclaredConnection(appkit, req.params.id, userEmail(req));
        if (!withdrawn) {
          res.status(404).json({ error: 'no_such_connection', detail: 'That connection is already withdrawn.' });
          return;
        }
        res.json({ connection: withdrawn, impact, restorable: true });
      } catch (error) {
        console.error('[connections] The connection could not be withdrawn:', (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail: 'The connection was not withdrawn.',
        });
      }
    });

    /** Put a withdrawn connection back. */
    app.post('/api/settings/connections/:id/restore', async (req, res) => {
      try {
        const restored = await restoreDeclaredConnection(appkit, req.params.id, userEmail(req));
        if (!restored) {
          res.status(404).json({
            error: 'no_such_connection',
            detail: 'There is no withdrawn connection under that name to put back.',
          });
          return;
        }
        res.json({ connection: restored, effect: addedConnectionEffect() });
      } catch (error) {
        console.error('[connections] The connection could not be restored:', (error as Error).message);
        res.status(503).json({ error: 'settings_store_unavailable', detail: 'The connection was not restored.' });
      }
    });

    /**
     * Record a value for one resource.
     *
     * 409, not 400, when the tier refuses it: the request was well formed and the
     * resource exists, what cannot be done is the thing being asked for. The
     * body carries the reason and the exact command that would work, so a client
     * can show the refusal without knowing the rules itself.
     */
    app.put('/api/settings/values/:resourceId', async (req, res) => {
      const parsed = WriteBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_settings_body', detail: parsed.error.message });
        return;
      }
      const { resourceId } = req.params;
      const decision = classifyWrite(resourceId, parsed.data.intent);
      if (!decision.ok) {
        res.status(409).json({ error: 'not_changeable_here', detail: decision.reason });
        return;
      }
      if (!parsed.data.value) {
        res.status(400).json({
          error: 'empty_value',
          detail: 'Saving an empty value would read as "configured as nothing". Delete it instead.',
        });
        return;
      }
      try {
        const saved = await writeStoredSetting(appkit, {
          resourceId,
          value: parsed.data.value,
          intent: decision.intent,
          note: parsed.data.note,
          updatedBy: userEmail(req),
        });
        res.json({
          saved,
          appliesNow: decision.intent === 'active',
        });
      } catch (error) {
        console.error(`[settings] ${resourceId} could not be saved:`, (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail:
            'The value was not saved. The app stores settings in Lakebase, and it is not answering: ' +
            'reporting success here would leave a value on screen that no restart would keep.',
        });
      }
    });

    app.delete('/api/settings/values/:resourceId', async (req, res) => {
      try {
        const removed = await clearStoredSetting(appkit, req.params.resourceId);
        if (!removed) {
          res.status(404).json({ error: 'no_such_setting', detail: 'Nothing was stored for that resource.' });
          return;
        }
        res.json({ cleared: req.params.resourceId });
      } catch (error) {
        console.error(`[settings] ${req.params.resourceId} could not be cleared:`, (error as Error).message);
        res.status(503).json({ error: 'settings_store_unavailable', detail: 'The value was not cleared.' });
      }
    });
  });
}

/** What the notebook published, and how it compares with what is running. */
export interface NotebookPanel {
  /** The table the declaration is read from, or '' when none is configured. */
  location: string;
  read: DeclarationRead;
  /** One entry per published setting. Empty when nothing was read. */
  comparison: DeclarationComparison[];
}

/**
 * The values the running orchestrator reported, keyed by its own field names.
 *
 * Taken from the configuration report rather than from `resourceStates`, because a
 * declaration is compared against agent field names and the states are keyed by
 * this app's registry ids. A value that is not a readable scalar is skipped, so a
 * key nobody can read is compared against nothing and reads as unknown rather than
 * as a disagreement.
 */
export function liveConfiguration(report: PreflightReport | null): Record<string, string> {
  const live: Record<string, string> = {};
  for (const entry of report?.configuration ?? []) {
    const key = String(entry.key ?? '');
    if (!key) continue;
    const value = entry.value;
    if (typeof value === 'string') live[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') live[key] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      live[key] = value.join(',');
    }
  }
  return live;
}

/**
 * Read the notebook's declaration and line it up against the running model.
 *
 * Never rejects, for the same reason as `readReachability`: the notebook row is one
 * of the things this page reports on, and a page opened to diagnose a deployment
 * must not be taken down by one of its subjects.
 */
async function readNotebook(req: Request,
  appkit: InsightsAppKit,
  report: PreflightReport | null
): Promise<NotebookPanel> {
  try {
    const location = await resolveNotebookDeclaration(appkit);
    const read = await readPublishedDeclaration({
      location,
      // The APP's own warehouse, which is what app.yaml binds. The orchestrator's
      // is in the model artifact and is not the app's to run statements on.
      warehouseId: process.env.DATABRICKS_SQL_WAREHOUSE_ID?.trim() ?? '',
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      // Absent reads as "nobody to read as", which the reader is told. It is never
      // replaced by the app's own credential.
      token: forwardedUserToken(req) ?? '',
    });
    return {
      location,
      read,
      comparison: read.declaration
        ? compareDeclaration(read.declaration, liveConfiguration(report))
        : [],
    };
  } catch (error) {
    console.warn('[settings] The notebook declaration could not be read:', (error as Error).message);
    return {
      location: '',
      read: { declaration: null, failure: 'unavailable', detail: 'The published declaration could not be read just now.' },
      comparison: [],
    };
  }
}

/** Every declared asset, with what withdrawing it would cost. */
export interface ConnectionEntry {
  connection: StoredDeclaredConnection;
  impact: RemovalImpact;
}

/**
 * The values the running deployment is configured with, as plain strings.
 *
 * Used only to decide whether withdrawing a declaration would change anything
 * about the running agent. Read from the same states the rows show, so the warning
 * agrees with the page it appears on.
 */
function configuredValues(states: ReturnType<typeof resourceStates>): string[] {
  const values: string[] = [];
  for (const state of states) {
    if (state.configured) values.push(state.configured);
    if (state.actual) values.push(state.actual);
  }
  return values;
}

async function impactFor(
  appkit: InsightsAppKit,
  connection: StoredDeclaredConnection
): Promise<RemovalImpact> {
  const { report } = await readOrchestratorReport(appkit);
  const stored = await readStoredSettings(appkit);
  const states = resourceStates({ report, environment: appEnvironment(), stored });
  return removalImpact(connection, configuredValues(states));
}

async function readConnections(
  appkit: InsightsAppKit,
  states: ReturnType<typeof resourceStates>
): Promise<ConnectionEntry[]> {
  const live = configuredValues(states);
  const connections = await readDeclaredConnections(appkit);
  return connections.map((connection) => ({
    connection,
    impact: removalImpact(connection, live),
  }));
}

/**
 * What the signed-in user can actually reach, asked of the workspace.
 *
 * THE JOB THE PAGE PROMISED AND NOBODY PICKED UP. `/api/preflight` has said for
 * releases that "whether a principal can reach a table, a warehouse or a Genie
 * space is answered by Unity Catalog and the workspace, which hold the grants",
 * because the orchestrator retired its own dependency report. That sentence
 * names where the answer lives; nothing went and got it, so the page carried on
 * offering to report reachability and answered `Not checked` for everything but
 * the two things the app probes for itself.
 *
 * Asked under the SIGNED-IN USER's forwarded token rather than the app's own
 * credential, because this app runs on behalf of the user and a reachability
 * answer computed under a service principal describes somebody who is not
 * reading the page. That is also why nothing here throws on a missing token:
 * `/api/settings` is one of the diagnostics that must keep answering when the
 * rest of the API is refusing, and the absent token is itself part of the
 * explanation a reader came for. It is reported as unchecked, which is what it
 * is.
 *
 * Never rejects. A dependency probe that took the settings route down would take
 * down the page somebody opens to find out why the deployment is misbehaving.
 */
async function readReachability(req: Request,
  input: {
    report: PreflightReport | null;
    environment: Record<string, string>;
    stored: Map<string, StoredSetting>;
  }
): Promise<PreflightCheck[]> {
  try {
    // Probed against the value each ROW SHOWS as configured, which is the
    // resolved one: the artifact's where the orchestrator owns it, and a saved
    // override ahead of the variable ahead of the compiled default where the app
    // does. Reading the raw configuration instead would answer about a value the
    // reader cannot see.
    const configured = Object.fromEntries(resourceStates(input).map((state) => [state.resource.id, state.configured])
    );
    const checks = await probeConnections({
      configured,
      tables: declaredTables(input.report?.configuration ?? []),
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      token: forwardedUserToken(req),
      principal: req.header('x-forwarded-email')?.trim() ?? '',
    });
    // The MLflow experiment, asked as the APPLICATION rather than as the reader,
    // because Databricks Apps has no MLflow scope to forward -- see
    // experiment-probe.ts, which carries the list of names the Apps API rejects.
    // Appended rather than folded into the probe set above so the scope
    // derivation, and the test that holds the bundle to it, are untouched.
    const experiment = await checkExperimentAsApp(configured['experiment-id'] ?? '');
    return experiment ? [...checks, experiment] : checks;
  } catch (error) {
    console.warn('[settings] The dependency probes could not be run:', (error as Error).message);
    return [];
  }
}

/**
 * Whether the store answers, as opposed to simply being empty.
 *
 * A read through the app's own schema rather than a bare connection probe: the
 * failure that matters here is a lost grant on `player_insights`, which a
 * connection-level check passes straight through.
 */
async function storeAnswers(appkit: InsightsAppKit): Promise<boolean> {
  try {
    await appkit.lakebase.query('SELECT 1 FROM player_insights.deployment_settings LIMIT 1');
    return true;
  } catch {
    return false;
  }
}
