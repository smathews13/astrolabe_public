/**
 * Browse what the signed-in user can see, for Connections pickers.
 *
 * Lists catalogs, schemas, tables, notebooks, SQL warehouses, Genie spaces and
 * model serving endpoints under the forwarded user token. Catalog and notebook
 * browse return a distinct unavailable outcome when their optional scopes are
 * not on the sign-in; see `shared/browse-contract.ts`.
 *
 * Not admin-gated: Connections is consumer-visible and these lists are about
 * what the reader themselves can see.
 */
import type { Request, Response } from 'express';
import type { InsightsAppKit } from './insights-routes';
import { forwardedUserToken } from './access-verification';
import {
  browseRequestContext,
  listCatalogs,
  listGenieSpaces,
  listNotebooks,
  listSchemas,
  listServingEndpoints,
  listTables,
  listWarehouses,
} from '../lib/browse-assets';

function queryString(req: Request, name: string): string {
  const raw = req.query[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function defaultNotebookPath(req: Request): string {
  const email = req.header('x-forwarded-email')?.trim();
  return email ? `/Users/${email}` : '/';
}

async function sendBrowse(
  req: Request,
  res: Response,
  run: (ctx: { host: string; token: string }) => Promise<unknown>,
): Promise<void> {
  const ctx = browseRequestContext({ token: forwardedUserToken(req) });
  const payload = await run(ctx);
  res.status(200).json(payload);
}

export function setupBrowseRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/browse/catalogs', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listCatalogs({ ...ctx, pageToken: queryString(req, 'page_token') || undefined }),
      );
    });

    app.get('/api/browse/schemas', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listSchemas({
          ...ctx,
          catalog: queryString(req, 'catalog'),
          pageToken: queryString(req, 'page_token') || undefined,
        }),
      );
    });

    app.get('/api/browse/tables', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listTables({
          ...ctx,
          catalog: queryString(req, 'catalog'),
          schema: queryString(req, 'schema'),
          pageToken: queryString(req, 'page_token') || undefined,
        }),
      );
    });

    app.get('/api/browse/notebooks', async (req, res) => {
      const path = queryString(req, 'path') || defaultNotebookPath(req);
      await sendBrowse(req, res, (ctx) => listNotebooks({ ...ctx, path }));
    });

    app.get('/api/browse/warehouses', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listWarehouses({ ...ctx, pageToken: queryString(req, 'page_token') || undefined }),
      );
    });

    app.get('/api/browse/genie-spaces', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listGenieSpaces({ ...ctx, pageToken: queryString(req, 'page_token') || undefined }),
      );
    });

    // Serves the three settings that name a served model: the foundation model,
    // the benchmark judge, and any agent endpoint a deployment points at. Not
    // the AI Gateway route, which is a three-value routing mode rather than an
    // object in the workspace.
    app.get('/api/browse/serving-endpoints', async (req, res) => {
      await sendBrowse(req, res, (ctx) =>
        listServingEndpoints({ ...ctx, pageToken: queryString(req, 'page_token') || undefined }),
      );
    });
  });
}
