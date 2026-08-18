# `bundle/`: the imperative steps

All of these default to a dry run. `--apply` executes.

**Read `DECISIONS.md` before changing a target's variables.** It records the
standing product decisions a release must not contradict, each with the date it
was taken and a sentence of reason. A decision that needs to change is changed in
that file, deliberately, rather than drifting.

`decisions-gate.py` holds a release's resolved configuration against the
machine-checkable ones and stops the release, naming the decision and its date,
before anything irreversible happens. There is no bypass flag, on purpose. The
decisions it can only display rather than enforce are printed beside the
configuration and marked as displayed in both places, because a check that
implied more coverage than it has would be worse than none.

**Both release scripts now call it, and there is no path around it.** In
`agent-release.sh` it runs immediately after the configuration readout and before
anything is exported to `log_model.py`; in `app-release.sh` it runs before the
rollback branch and before the dry-run branch, so a dry run and a rollback are both
held to it. A dry run reports it deliberately: a dry run is where somebody checks a
target before committing to it, and a gate that only spoke on `--apply` would stay
quiet at the one moment it is cheap to act on.

`genie-drift.sh` answers a different and narrower question: is the Genie content
in this repository what the workspace is actually serving? It reads and changes
nothing, so it is safe to run mid-deploy or mid-demo. Exit 0 means a deploy would
change nothing; exit 1 means the committed body is not the live one.

It compares the TEXT rather than `serialized_space.version` or the instruction
ids, and that distinction is the whole reason it exists. A version nobody bumped
sits happily above a rewritten paragraph, so a tag-based check agrees with the
deploy rather than with the workspace — which is how a Genie change was once
committed, deployed, reported successful, and never landed. The comparison runs in
both directions, because `bundle deploy` overwrites these bodies whole: a table
that is live and no longer committed is drift too, and the next deploy deletes it.

What it cannot tell you is whether an instruction that landed is being **followed**.
Those look identical from outside; ask the space a question that depends on the
change. Whether the curated tables are inside the model's declared scopes is
`genie-live-check.py`, kept separate because it is a different question.

`TARGET` is required and has no default: guessing one aims a release at a
workspace. `PROFILE` is optional for a target that names its CLI profile in
`databricks.yml`, since it is read back from there; every other target must state
one (`PROFILE=<their-profile>`). If a profile name contains a space, keep it
quoted wherever you pass it.

## Deployment order on a fresh workspace

Nothing enforces this order, so following it is on you.

1. `bundle deploy -t <target>` with `--select` for every resource except the app.
2. `bundle/agent-release.sh`, which creates the serving endpoint.
3. `bundle deploy -t <target>` again with no `--select`, which creates the app.
   Both passes are needed: `Apps.Create` refuses an attachment naming a serving
   endpoint that does not exist yet, and creates nothing.
4. `bundle/app-release.sh`, which pushes the app's code.

Three steps in that sequence are manual. The administrator input now fails
validation when skipped; the remaining workspace grants still require review.

- **Name the deployment's administrators**, before step 4, because there is no
  way to appoint the first one from inside the running app:

  ```bash
  # .databricks/bundle/<target>/variable-overrides.json, which is git-ignored
  { "admin_emails": "someone@example.com,someone.else@example.com" }
  ```

  `admin_emails` is a required bundle variable, and the app release also rejects
  an explicitly empty value. Without those checks, the app would start and
  refuse every caller on Monitoring, Ops and the settings gear with a 403.
  **The admin-list editor that would fix it is behind the same refusal, so that
  deployment would be self-locking and the only way out would be another
  release.**

  The value must not go in `databricks.yml`, which is tracked and published: an
  address is a personal name and an employer, and both are on the publication's
  sensitive list. `databricks.yml` declares `admin_emails` without a default so
  validation requires a private override. `PLAYER_INSIGHTS_ADMIN_EMAILS` in the
  environment wins over the file for a one-off that should not change what the
  target records.

  **`build/deploy/app.yaml` is where the addresses actually land, and it is
  tracked.** The release uploads the local build tree directly, so the container
  gets the list without a commit. Do not commit it:
  `git restore player-insights-agent/build/deploy/app.yaml`. The build prints
  the same warning, and a test fails while the addresses are there:

  ```bash
  cd player-insights-agent && npx vitest run scripts/deploy-app-yaml.test.ts
  ```

  **That test is the only thing catching this before the commit**, so do not
  weaken it to get one through. The mirror leak check still blocks on the
  addresses, but it gates the publication and no longer scans the internal tree,
  which puts it after the commit rather than before it.

- **Grant the app's Postgres role**, after step 3, because the app's service
  principal does not exist until the app does:

  ```bash
  cd player-insights-agent && node scripts/grant-app-db-access.mjs
  ```

  Skipped, every route answers from representative data at HTTP 200 with no
  error anywhere.

- **Share each Genie space with the agent's serving principal as `CAN RUN`.**
  There is no CLI and no bundle resource for this, so it is a UI step. Skipped,
  every Genie call fails `PermissionDenied` and the agent's SQL fallback answers
  anyway.

## The scripts

| Script | What it does |
| --- | --- |
| `agent-release.sh` | Log the model, deploy it to the serving endpoint, wait for the traffic switch, read back the served versions, then prune the entities the release superseded. `--no-prune` leaves them and reports what it would have removed. |
| `prune-served-entities.py` | Remove idle served entities from the endpoint, keeping whatever holds traffic plus `var.serving_rollbacks_kept` rollbacks — which defaults to **none**, because the version a kept rollback reaches is the one released *before* the current fix. Run by `agent-release.sh`; also runnable alone. Reports by default, acts on `--apply`, exits 3 when there is something to prune and it was not asked to. Endpoint only: it has no code path that reaches the registry, so every version stays registered and can be served again with `deploy_agent.py --model-version N` — that is the rollback path, and it needs no idle entity held open for it. |
| `app-release.sh` | Resolve the MLflow experiment id for the target, build the dependency-free tree, upload, deploy. The only way app code is pushed; `npm run deploy` is an alias for it. `--rollback-to <workspace-path>` re-points the app at a known-good source directory without rebuilding. |
| `app-spec.sh` | Emit the complete app spec for a target, generated from `bundle validate` so it can only carry that target's own values. Prints by default; `--apply` sends it and verifies what the API kept. Recovery only: the bundle owns this resource. Refuses to write on a host mismatch, a Lakebase project absent from the workspace being written to, a serving endpoint that does not exist (`--allow-missing-endpoint` for bootstrap), a lost load-bearing `user_api_scopes` entry, or a `sql-warehouse` resource with no id. |
| `plan-gate.sh` | Refuse a `bundle deploy` that would delete or replace a resource. **This one blocks** — unlike the advisory suites, which report and are swallowed. About two seconds, so chain it: `TARGET=<t> bundle/plan-gate.sh && databricks bundle deploy -t <t>`. Decision logic in `plan-gate.py`, proved by `plan-gate.test.sh`. |
| `assert-sp-no-data-select.py` | Ask Unity Catalog what the app's service principal can actually reach on the catalog, the data schema and every table in it — effective permissions, so a privilege inherited through `account users` is found where `SHOW GRANTS` shows nothing. Exceptions live in `sp-data-access-exceptions.json`, cover one grant each, and expire. **`agent-release.sh` runs it as a blocking gate**, before the model is logged, because a re-log is when the agent's data access changes. Exit 1 is a finding, exit 2 is "could not run" — *both stop the release*, separated only so the operator is told which. There is no flag past it; an accepted finding goes in the exceptions file with a review date, not on the command line. Also runnable alone: `--app`, `--catalog`, `--schema`, `--profile`. |

## Before `bundle deploy`

Nothing in this repository runs `bundle deploy`; it is always a person at a
terminal, and it is the one command here that can remove a resource. Two of them
hold things that do not come back — `schemas.player_insights_schema` has the
registered model and app-owned semantic assets, and
`schemas.player_insights_telemetry_schema` has app history that does not backfill.
Both carry `prevent_destroy`, which stops `bundle destroy` and does **not** stop a
`replace`.

So run the gate and let `&&` do the deciding:

```bash
TARGET=<target> bundle/plan-gate.sh && databricks bundle deploy -t <target>
```

`bundle deploy` prints its own plan and asks, so this is redundant in principle.
In practice the twentieth deploy is read less carefully than the first. If a
removal is intended, acknowledge it by name rather than skipping the gate:

```bash
TARGET=<target> PIA_PLAN_ALLOW_DESTROY=resources.jobs.some_retired_job \
  bundle/plan-gate.sh && databricks bundle deploy -t <target>
```

## Verifying a deployment

A deployment can be built exactly right and still answer every question from
canned representative data, and none of these fail loudly. Establish that:

- both env-var-bearing app resources (`postgres` and `serving-endpoint`) are
  attached to the live app, and every `user_api_scopes` entry the bundle authors
  is in effect on it rather than merely declared. `databricks apps get
  <app-name> -o json` reports the resources and scopes the platform actually
  holds, which is the one place a lost attachment shows;
- the serving endpoint exists and is reachable;
- the app's Postgres role holds grants on the schema the app's own DDL creates;
- every table each Genie space curates is inside the manifest the logged model
  declares. A table outside it fails every Genie call, and the agent's SQL
  fallback answers anyway.
