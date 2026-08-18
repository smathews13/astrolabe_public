# Player Insights Agent

A Databricks App and MLflow ResponsesAgent for governed player analytics.

Deployed as a Databricks Asset Bundle. `bundle/README.md` is the runbook and is
more detailed than this page; what follows is the shortest path through it.

## Read this before you point Apps at this repo

**Source code path is `player-insights-agent/build/deploy`. Nothing to build first.**
That directory is committed, holds the bundled server and the built client, and has no
`package.json` on purpose, so the platform skips `npm install` and the deploy takes about
15 seconds. Only rebuild it if you change the code: `cd player-insights-agent && npm
install && npm run build:deploy`, then `git add build/deploy` and commit.

**Both of the obvious paths fail without telling you why.** The repo root has no
`app.yaml`. `player-insights-agent/` hangs, because the platform finds a `package.json`
and runs `npm install` across 508 packages with no registry egress.

**Two `app.yaml` files exist and only one is deployable.**
`player-insights-agent/app.yaml` is the source, runs `npm run start`, and is not what
Apps deploys. `player-insights-agent/build/deploy/app.yaml` is the built one, runs the
bundled server, and is the one Apps reads.

## What the workspace needs first

The bundle declares the app, its Unity Catalog schema and volume, its MLflow
experiment, two Genie spaces, and its Lakebase project, branch, and database.
The release script logs the model and creates the serving endpoint. Have these
inputs before you start:

- an existing Unity Catalog catalog for the app's own objects;
- the production catalogs or schemas the agent may read;
- the fully qualified tables each Genie space should curate;
- an existing SQL warehouse;
- a Lakebase project id to create and an existing owner role id from
  `databricks postgres list-roles`.

## Deploy

Every value below is yours; nothing is guessed for you, and a missing one stops
`validate` rather than resolving to something wrong.

```bash
databricks bundle validate -t customer --profile <your-profile> \
  --var app_catalog=<app-catalog> \
  --var app_schema=<app-schema> \
  --var warehouse_id=<id> \
  --var app_source_code_path=/Workspace/Shared/player-insights-agent-src \
  --var lakebase_project_id=<project-id> \
  --var lakebase_owner_role_id=<role-id>
```

Put those values, plus the complex `data_catalogs`, `data_genie_tables`, and
`dictionary_genie_tables` lists, in
`.databricks/bundle/customer/variable-overrides.json` instead of repeating
them. For example:

```json
{
  "app_catalog": "analytics_apps",
  "app_schema": "player_insights",
  "data_catalogs": ["production", "shared.reference_data"],
  "data_genie_tables": [
    {"identifier": "production.player_metrics.daily_summary"}
  ],
  "dictionary_genie_tables": [
    {"identifier": "shared.reference_data.data_dictionary"}
  ]
}
```

`data_catalogs` is the complete read boundary. A catalog name includes all of
its non-system schemas; `catalog.schema` limits the boundary to one schema.
The app schema is separate and holds only app-owned objects.

The order matters, because `Apps.Create` refuses an app that names a serving
endpoint which does not exist yet, and it creates nothing when it refuses:

1. `databricks bundle deploy -t customer` with `--select` for every resource
   except the app.
2. `TARGET=customer bundle/agent-release.sh --apply`, which logs the model and
   creates the serving endpoint.
3. `databricks bundle deploy -t customer` again, with no `--select`, which
   creates the app.
4. `TARGET=customer bundle/app-release.sh --apply`, which pushes the app's code.

## Deploy the app from the browser (Databricks Apps "From Git")

The four steps above deploy the whole stack from the CLI. If the backend already
exists — catalog, schema, SQL warehouse, Lakebase, and the **serving endpoint**
(steps 1–2, which have no browser equivalent) — the app tier can be created and
deployed entirely from the Databricks UI, no terminal required.

**No build first.** `player-insights-agent/build/deploy/` is committed and is what you
point the platform at: a dependency-free tree holding an `app.yaml`, the bundled server
and the built client, with **no package.json**.

The missing package.json is the point. The platform runs `npm install` whenever the
source it downloads contains one, and a full install of this app's 508-package tree has
no registry egress on app compute and hangs. Without one, the platform logs "No
dependencies file found. Skipping installation" and the deploy takes ~15s.

Rebuild it only when you change the code, and commit the result — a built tree is a
snapshot that goes stale the moment anyone edits the source:

```bash
cd player-insights-agent && npm install && npm run build:deploy
git add build/deploy && git commit -m "Rebuild the deployable tree" && git push
```

Nothing workspace-specific is baked into what that build writes. Every such value
is read from the environment at run time: host, app name and workspace id are
injected by the platform; the Lakebase endpoint, serving endpoint and SQL
warehouse come from the resources you attach in step 4 (`valueFrom`); and the
optional flags default to the customer-safe settings (the conversation rail
scoped per user, experiment id and judge endpoint empty, and no administrators).
So a new workspace supplies its own options by attaching its own resources — it
inherits none from the build.

1. **Apps → Create app → Deploy from Git.**
2. Give the repo URL and branch. For a private repo the app's service principal
   needs a Git credential first, or Apps refuses the deploy.
3. **Set Source code path. Do not leave Source code path blank.** The exact
   value is:

   ```
   player-insights-agent/build/deploy
   ```

   Left blank, the platform deploys from the repository root, which does not
   contain `app.yaml`, and the deploy fails with the missing-app.yaml error
   ("No command to run and no Python file found / Failed to load app spec").
   If that happens, edit or recreate the deployment, set Source code path to the
   exact value above, and redeploy. The field may not persist when you start a
   new Deploy from Git flow, so confirm it is set before every deploy.
4. Attach the resources the `app.yaml` reads by `valueFrom`: the **Lakebase
   (postgres)** instance, the **serving endpoint**, and the **SQL warehouse**;
   set the OAuth scopes the app declares.
5. Deploy.

This path cannot be preset from the repository. It is deployment configuration,
chosen when you deploy, not something `app.yaml` can supply: the platform needs
the path before it can find and read `app.yaml`. The Deploy from Git flow has no
CLI or config-file shortcut for it, so set it in the browser every time.

Then do the two steps below — they apply however the app was deployed.

**Updating the code is not browser-only.** Every later code change needs the rebuild and
commit above before the next Git deploy serves it. The platform cannot build it for you.

## Two steps nothing does for you

Neither fails loudly. Skipped, the app returns HTTP 200 and answers are wrong in
a way no error reports.

**Grant the app's Postgres role**, after step 3, since the app's service
principal does not exist until the app does:

```bash
cd player-insights-agent && node scripts/grant-app-db-access.mjs
```

Skipped, every route answers from representative data rather than yours.

**Share each Genie space with the serving endpoint's principal as `CAN RUN`.**
There is no CLI or bundle resource for this, so it is a UI step. Skipped, every
Genie call fails `PermissionDenied` and the agent answers from SQL anyway.

## Who can sign in

Each person using the app needs the `workspace-access` and
`databricks-sql-access` entitlements. Without the second, the OAuth sign-in
fails in a loop rather than saying what is missing. The app's own refusal screen
prints the command that grants them.

## Who can administer it

Administrators see Monitoring, Ops and the settings gear. Every admin route
still refuses consumers with a 403.

The first administrators are named at release time and cannot be appointed from
inside the app. Put the list in the git-ignored
`.databricks/bundle/<target>/variable-overrides.json`, beside `app_catalog` and
`warehouse_id`:

```json
{ "admin_emails": "someone@example.com,someone.else@example.com" }
```

`bundle/app-release.sh` reads it and passes it to the build, which writes it into
the app's `app.yaml`. `PLAYER_INSIGHTS_ADMIN_EMAILS` in the environment you
release from wins over the file. Administrators added later from the settings
gear are stored in Lakebase and are additional to these.

**`admin_emails` is required.** Bundle validation fails when it is unset, and
the release script also refuses an explicitly empty value. Without those
checks, the app would start and refuse every admin surface, including the editor
that appoints someone. There is no way in from the running app; the only fix
would be another release with a value set. The bundle and release script refuse
that self-locking configuration before deployment.

Deploying from Git in the browser bypasses the release, so it produces a
deployment with no administrators. Supply the list yourself in that flow, either
by running `bundle/app-release.sh` once against the same workspace, or by setting
`PLAYER_INSIGHTS_ADMIN_EMAILS` before the build so it lands in the app.yaml the
build writes — your repo, your employees. Do not send it back upstream.

## The semantic layer (optional, off by default)

The semantic layer is a governed index over your schema's metadata: table and
column descriptions, metric and term definitions, approved joins and example
questions. It helps the agent find the right table faster. It indexes metadata,
not measurements, and the agent never answers from it. Every number still comes
from Genie and the guarded SQL path, which run under the caller's grants. The app
works fully without it.

It costs money while it exists. Turning it on creates an AI Search endpoint,
which is charged by the hour whether or not anything queries it, roughly $200 a
month for one left running. Turn it on only if better schema discovery is worth
that to you, and delete the index and then the endpoint when you are done.

By default the bundle creates only a **paused** rebuild job. The endpoint and
index are supplied by variables that default to empty, so
`bundle deploy -t customer` creates no billed AI Search resources until you opt
in. The paused job runs nothing and incurs no compute charge.

To turn it on:

1. Deploy the backing resources and paused rebuild job, then run the job once to
   build the source table. It must exist before a `DELTA_SYNC` index can be
   created over it:

   ```bash
   databricks bundle deploy -t customer
   databricks bundle run player_insights_semantic_rebuild -t customer
   ```

2. Add the endpoint name and the two resource maps to your git-ignored
   `.databricks/bundle/customer/variable-overrides.json`. The index name and its
   source table are built from your `app_catalog` and `app_schema`:

   ```json
   {
     "semantic_index_endpoint": "player-insights-semantic",
     "semantic_index_endpoints": {
       "semantic_endpoint": {
         "name": "${var.semantic_index_endpoint}",
         "endpoint_type": "${var.semantic_index_endpoint_type}"
       }
     },
     "semantic_index_indexes": {
       "semantic_index": {
         "name": "${var.app_catalog}.${var.app_schema}.semantic_layer_index",
         "endpoint_name": "${var.semantic_index_endpoint}",
         "index_type": "DELTA_SYNC",
         "index_subtype": "HYBRID",
         "primary_key": "entry_id",
         "delta_sync_index_spec": {
           "source_table": "${var.app_catalog}.${var.app_schema}.semantic_layer_entries",
           "pipeline_type": "${var.semantic_index_pipeline_type}",
           "embedding_source_columns": [
             { "name": "content", "embedding_model_endpoint_name": "${var.semantic_embedding_endpoint}" }
           ]
         }
       }
     }
   }
   ```

3. Deploy: `databricks bundle deploy -t customer`.

4. Re-log the model so it gains the retrieval tool. The Vector Search scopes are
   baked into the model artifact at log time, so a running model does not gain the
   tool until it is logged again:

   ```bash
   TARGET=customer bundle/agent-release.sh --apply
   ```

   With `semantic_index_endpoint` empty the release logs a model with no retrieval
   tool, which is the off state, so this step is what actually turns the layer on.

The rebuild schedule remains paused after deployment. Each entry records who
could read the source when it was built, which decides whose search results it
appears in. Review the job identity and its first output before unpausing the
schedule; a revoked grant remains discoverable until the next successful build.

## Verifying it actually works

A deployment can be built correctly and still answer everything from canned
data. `bundle/README.md` lists what to establish; the short version is that
`databricks apps get <app-name> -o json` should show both the `postgres` and
`serving-endpoint` resources attached and every declared scope in effect.
