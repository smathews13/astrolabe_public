/**
 * List what the signed-in user can see, for Connections pickers.
 *
 * Calls the workspace as the forwarded user token. Catalog browse needs the
 * optional `catalog.*:read` scopes; when the sign-in does not carry them the
 * answer is {@link BrowseUnavailable}, never an empty list. See
 * `shared/browse-contract.ts`.
 */
import {
  browseScopeUnavailableDetail,
  type BrowseFailed,
  type BrowseItem,
  type BrowseKind,
  type BrowseOk,
  type BrowseResponse,
  type BrowseUnavailable,
} from '../../shared/browse-contract';
import { declaredUserApiScopes } from '../../shared/declared-scopes';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import {
  looksLikeMissingScope,
  scopesFromToken,
} from '../routes/access-verification';
import {
  refusalCause,
  scopeForPath,
  scopesFromRefusal,
  tokenScopeVerdict,
} from './dependency-probes';

/** How long one browse call may take. Same order as a metadata probe. */
export const BROWSE_TIMEOUT_MS = 15_000;

/** Default page size for paged Databricks list APIs. */
export const BROWSE_PAGE_SIZE = 100;

/**
 * Workspace API families this module lists, mapped to Apps-API scopes.
 *
 * Catalog paths reuse {@link scopeForPath}. Workspace list is not on the probe
 * map today. Its scope is `workspace.workspace:read`, which is the name the
 * Apps API accepts: the bare `workspace` the OAuth server advertises is
 * rejected there, exactly as `unity-catalog` is. A deployment that has not
 * declared it gets `unavailable` here rather than a 403 nobody can read.
 */
const BROWSE_SCOPE_BY_PATH: Readonly<Record<string, string>> = {
  '/api/2.1/unity-catalog/catalogs': 'catalog.catalogs:read',
  '/api/2.1/unity-catalog/schemas': 'catalog.schemas:read',
  '/api/2.1/unity-catalog/tables': 'catalog.tables:read',
  '/api/2.0/sql/warehouses': 'sql',
  '/api/2.0/genie/spaces': 'dashboards.genie',
  '/api/2.0/workspace/list': 'workspace.workspace:read',
  '/api/2.0/serving-endpoints': 'serving.serving-endpoints',
};

function scopeForBrowsePath(path: string): string {
  const exact = BROWSE_SCOPE_BY_PATH[path];
  if (exact) return exact;
  return scopeForPath(path.endsWith('/') ? path : `${path}/`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function unavailable(kind: BrowseKind, scope: string): BrowseUnavailable {
  return {
    status: 'unavailable',
    kind,
    reason: 'scope_not_carried',
    scope,
    detail: browseScopeUnavailableDetail(scope),
  };
}

function failed(kind: BrowseKind, detail: string, error = ''): BrowseFailed {
  return { status: 'failed', kind, detail, error };
}

function ok(
  kind: BrowseKind,
  items: BrowseItem[],
  nextPageToken = '',
  path = '',
): BrowseOk {
  return {
    status: 'ok',
    kind,
    items,
    next_page_token: nextPageToken,
    path,
  };
}

export interface BrowseCallOptions {
  host: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Override declared scopes for tests. Defaults to the container's list. */
  declaredScopes?: string[] | null;
}

type WorkspaceAnswer =
  | { kind: 'http'; status: number; body: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; message: string };

async function workspaceGet(
  pathAndQuery: string,
  options: BrowseCallOptions,
): Promise<WorkspaceAnswer> {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BROWSE_TIMEOUT_MS;
  try {
    const response = await call(`${options.host}${pathAndQuery}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: 'http', status: response.status, body: body ?? {} };
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'unreachable', message: (error as Error)?.message ?? String(error) };
  }
}

/**
 * Whether browsing should be refused before the workspace is asked.
 *
 * Returns the scope name when the sign-in demonstrably lacks it, or when the
 * app does not declare it so no sign-in can carry it. Returns null when the
 * call should still be made (scope held, or token silent).
 */
export function browseBlockedByScope(input: {
  apiPath: string;
  token: string;
  declaredScopes?: string[] | null;
}): string | null {
  const scope = scopeForBrowsePath(input.apiPath);
  if (!scope) return null;

  const declared =
    input.declaredScopes === undefined ? declaredUserApiScopes() : input.declaredScopes;
  // App does not ask for it: no sign-in it hands out can carry it.
  if (declared && !declared.includes(scope)) {
    return scope;
  }

  const held = scopesFromToken(input.token);
  if (held === null) return null;
  const verdict = tokenScopeVerdict(held, scope);
  if (verdict === false) return scope;
  return null;
}

/**
 * Turn a workspace HTTP answer into a browse response for one kind.
 *
 * Pure against the answer, so tests cover scope refusal without a network.
 */
export function interpretBrowseAnswer(input: {
  kind: BrowseKind;
  apiPath: string;
  answer: WorkspaceAnswer;
  itemsFromBody: (body: Record<string, unknown>) => {
    items: BrowseItem[];
    next_page_token: string;
  };
  path?: string;
  /** Scopes readable off the token, or null when the token did not say. */
  tokenScopes?: string[] | null;
}): BrowseResponse {
  const { kind, apiPath, answer } = input;

  if (answer.kind === 'timeout') {
    return failed(
      kind,
      'The workspace did not answer in time, so nothing about this list was established.',
      'timeout',
    );
  }
  if (answer.kind === 'unreachable') {
    return failed(
      kind,
      'The workspace could not be asked for this list, so nothing was established.',
      answer.message,
    );
  }

  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    const parsed = input.itemsFromBody(body);
    return ok(kind, parsed.items, parsed.next_page_token, input.path ?? '');
  }

  const code = text(body.error_code);
  const message = text(body.message);
  const scope = scopeForBrowsePath(apiPath);
  const named = scopesFromRefusal(message);
  const looksScope = named.length > 0 || looksLikeMissingScope(message);
  const tokenScopes = input.tokenScopes ?? null;
  const scopeHeld = tokenScopes === null ? null : tokenScopeVerdict(tokenScopes, scope);

  if (status === 403 || code === 'PERMISSION_DENIED') {
    // Scope held: this is a grant problem, not a browse-capability problem.
    if (scopeHeld === true && !looksScope) {
      return failed(
        kind,
        `The workspace refused this list: HTTP ${status}${code ? ` ${code}` : ''}. ` +
          'Your sign-in carries the API permission, so this is likely a grant on the object.',
        message || `HTTP ${status}`,
      );
    }
    // Scope named by the workspace, or a bare catalog 403 when the token does
    // not demonstrably hold the scope. Catalog metadata refusals often arrive
    // with no body; the three catalog scopes are optional on this app, so that
    // shape is reported as browsing unavailable rather than empty or failed.
    if (looksScope || (scope.startsWith('catalog.') && scopeHeld !== true)) {
      return unavailable(kind, scope || named[0] || 'required');
    }
    const cause = refusalCause({ message, code, scope, scopeHeld });
    if (cause.kind === 'scope') {
      return unavailable(kind, cause.scope || scope || 'required');
    }
    return failed(
      kind,
      `The workspace refused this list: HTTP ${status}${code ? ` ${code}` : ''}. ` +
        'That may be a grant on the object rather than a missing sign-in permission.',
      message || `HTTP ${status}`,
    );
  }

  return failed(
    kind,
    `The workspace refused this list: HTTP ${status}${code ? ` ${code}` : ''}.`,
    message || `HTTP ${status}`,
  );
}

function pageQuery(pageToken: string | undefined, pageSize = BROWSE_PAGE_SIZE): string {
  const parts = [`max_results=${pageSize}`];
  // Warehouses use page_size; UC uses max_results. Callers pass the right one
  // via extraQuery when needed. Default is UC-shaped.
  if (pageToken) parts.push(`page_token=${encodeURIComponent(pageToken)}`);
  return parts.join('&');
}

async function listWithGuard(
  kind: BrowseKind,
  apiPath: string,
  pathAndQuery: string,
  options: BrowseCallOptions,
  itemsFromBody: (body: Record<string, unknown>) => {
    items: BrowseItem[];
    next_page_token: string;
  },
  listedPath = '',
): Promise<BrowseResponse> {
  if (!options.host) {
    return failed(
      kind,
      'This app was given no workspace host, so it does not know where to browse.',
    );
  }
  if (!options.token) {
    return failed(
      kind,
      'This request carried no signed-in user token, so browsing as you is not possible.',
    );
  }

  const blocked = browseBlockedByScope({
    apiPath,
    token: options.token,
    declaredScopes: options.declaredScopes,
  });
  if (blocked) return unavailable(kind, blocked);

  const answer = await workspaceGet(pathAndQuery, options);
  return interpretBrowseAnswer({
    kind,
    apiPath,
    answer,
    itemsFromBody,
    path: listedPath,
    tokenScopes: scopesFromToken(options.token),
  });
}

function catalogItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.catalogs) ? body.catalogs : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = text((row as Record<string, unknown>).name);
    if (!name) continue;
    items.push({ id: name, label: name, secondary: '', expandable: false });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function schemaItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.schemas) ? body.schemas : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const fullName = text(record.full_name);
    const name = text(record.name);
    // Prefer the schema segment alone as `id`: the next drill-down already has
    // the catalog in the query string.
    const schemaName = name.includes('.')
      ? name.slice(name.indexOf('.') + 1)
      : name || (fullName.includes('.') ? fullName.slice(fullName.indexOf('.') + 1) : fullName);
    if (!schemaName) continue;
    items.push({
      id: schemaName,
      label: schemaName,
      // The two-part name, because one field stores it: `data_catalogs` takes
      // either a whole catalog or a single `catalog.schema`, and those mean
      // materially different things. Carried here so the picker for that field
      // can offer the exact string rather than assemble one and be wrong.
      secondary: fullName,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function tableItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.tables) ? body.tables : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const fullName = text(record.full_name) || text(record.name);
    if (!fullName) continue;
    const short = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    items.push({
      id: fullName,
      label: short,
      secondary: text(record.table_type),
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function warehouseItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.warehouses) ? body.warehouses : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = text(record.id);
    if (!id) continue;
    items.push({
      id,
      label: text(record.name) || id,
      secondary: text(record.state),
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function genieItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.spaces) ? body.spaces : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = text(record.space_id) || text(record.id);
    if (!id) continue;
    items.push({
      id,
      label: text(record.title) || id,
      secondary: '',
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

/**
 * One row per serving endpoint, whatever it serves.
 *
 * Deliberately unfiltered. Three settings pick from this list, and they do not
 * want the same rows: the foundation model wants a chat endpoint, the benchmark
 * judge usually the same, and a deployment can point either at an agent
 * endpoint somebody else logged. Filtering by `task` would hide a legitimate
 * pick from one of them, so the task is reported instead and the reader
 * chooses. An endpoint with no task reports its readiness, which is the only
 * other thing the list payload knows about it.
 */
function servingEndpointItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.endpoints) ? body.endpoints : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const state = record.state;
    const ready =
      state && typeof state === 'object' ? text((state as Record<string, unknown>).ready) : '';
    items.push({
      id: name,
      label: name,
      secondary: text(record.task) || ready,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function notebookItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.objects) ? body.objects : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const path = text(record.path);
    if (!path) continue;
    const objectType = text(record.object_type).toUpperCase();
    // Directories and notebooks only. Libraries, files, repos stay out of a
    // "pick a notebook" picker.
    if (objectType !== 'DIRECTORY' && objectType !== 'NOTEBOOK') continue;
    const label = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    items.push({
      id: path,
      label: label || path,
      secondary: objectType === 'NOTEBOOK' ? text(record.language) : 'Directory',
      expandable: objectType === 'DIRECTORY',
    });
  }
  return { items, next_page_token: '' };
}

export async function listCatalogs(
  options: BrowseCallOptions & { pageToken?: string },
): Promise<BrowseResponse> {
  const apiPath = '/api/2.1/unity-catalog/catalogs';
  const query = pageQuery(options.pageToken);
  return listWithGuard('catalogs', apiPath, `${apiPath}?${query}`, options, catalogItems);
}

export async function listSchemas(
  options: BrowseCallOptions & { catalog: string; pageToken?: string },
): Promise<BrowseResponse> {
  const catalog = options.catalog.trim();
  if (!catalog) {
    return failed('schemas', 'A catalog name is required to list schemas.');
  }
  const apiPath = '/api/2.1/unity-catalog/schemas';
  const query = `catalog_name=${encodeURIComponent(catalog)}&${pageQuery(options.pageToken)}`;
  return listWithGuard('schemas', apiPath, `${apiPath}?${query}`, options, schemaItems);
}

export async function listTables(
  options: BrowseCallOptions & { catalog: string; schema: string; pageToken?: string },
): Promise<BrowseResponse> {
  const catalog = options.catalog.trim();
  const schema = options.schema.trim();
  if (!catalog || !schema) {
    return failed('tables', 'A catalog and schema are required to list tables.');
  }
  const apiPath = '/api/2.1/unity-catalog/tables';
  const query =
    `catalog_name=${encodeURIComponent(catalog)}` +
    `&schema_name=${encodeURIComponent(schema)}` +
    `&${pageQuery(options.pageToken)}`;
  return listWithGuard('tables', apiPath, `${apiPath}?${query}`, options, tableItems);
}

export async function listWarehouses(
  options: BrowseCallOptions & { pageToken?: string },
): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/sql/warehouses';
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard('warehouses', apiPath, `${apiPath}?${parts.join('&')}`, options, warehouseItems);
}

export async function listGenieSpaces(
  options: BrowseCallOptions & { pageToken?: string },
): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/genie/spaces';
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard(
    'genie-spaces',
    apiPath,
    `${apiPath}?${parts.join('&')}`,
    options,
    genieItems,
  );
}

/**
 * List the model serving endpoints the signed-in user can see.
 *
 * On the `serving.serving-endpoints` scope, which this app already declares for
 * the orchestrator endpoint check, so this list adds no consent risk. The list
 * API has answered without a page token every time it has been read here; the
 * token is passed through anyway rather than assumed absent.
 */
export async function listServingEndpoints(
  options: BrowseCallOptions & { pageToken?: string },
): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/serving-endpoints';
  const parts: string[] = [];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  const query = parts.length ? `?${parts.join('&')}` : '';
  return listWithGuard(
    'serving-endpoints',
    apiPath,
    `${apiPath}${query}`,
    options,
    servingEndpointItems,
  );
}

/**
 * List one workspace directory for notebook browsing.
 *
 * `path` is required. The route defaults it to the signed-in user's home when
 * the client omits it. There is no page token; open a directory via its path.
 */
export async function listNotebooks(
  options: BrowseCallOptions & { path: string },
): Promise<BrowseResponse> {
  const path = options.path.trim();
  if (!path) {
    return failed('notebooks', 'A workspace path is required to list notebooks.');
  }
  const apiPath = '/api/2.0/workspace/list';
  const query = `path=${encodeURIComponent(path)}`;
  return listWithGuard(
    'notebooks',
    apiPath,
    `${apiPath}?${query}`,
    options,
    notebookItems,
    path,
  );
}

/** Host + token from the request environment, shared by every browse route. */
export function browseRequestContext(input: {
  token: string | null;
  host?: string;
}): { host: string; token: string } {
  return {
    host: normalizeWorkspaceHost(input.host ?? process.env.DATABRICKS_HOST ?? ''),
    token: input.token?.trim() ?? '',
  };
}
