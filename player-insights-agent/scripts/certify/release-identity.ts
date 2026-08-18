/**
 * The exact thing a certificate is about.
 *
 * A certificate that says "this deployment was fine" is worthless the moment
 * anything under it moves, and in this system the app and the model move
 * SEPARATELY: `bundle/app-release.sh` pushes app code, `bundle/agent-release.sh`
 * logs and serves a model version, and neither knows the other ran. So the
 * certificate binds to a tuple, and a promotion has to present a certificate
 * whose tuple digest equals the tuple in front of it.
 *
 * EVERY FIELD IS A STRING, AND `''` MEANS UNKNOWN. Not "unset", not "default":
 * unknown. `agent/preflight.py` made the same choice for the build stamp and
 * wrote down why, and it is the reason this file has no `'unknown'` sentinel
 * value either. A reader that cannot tell absence from agreement will eventually
 * report agreement.
 *
 * Unknown fields are not fatal here. They are fatal in the check that reads them
 * (see RELEASE_IDENTITY_COMPLETE), which is where the decision belongs, because
 * a tuple is also built for a dry run against a workspace that has not been
 * deployed into yet and printing that is useful.
 */
import { createHash } from 'node:crypto';

/** Whether a model version was logged so its tools run as the caller. */
export type UserAuthPolicyState = 'enabled' | 'disabled' | 'unknown';

export interface ReleaseTuple {
  /** The `databricks.yml` target. Two workspaces are two releases. */
  target: string;
  appName: string;
  /**
   * The commit the deployed app tree was built from, as the running app reports
   * it. Carries `+dirty` when the tree had uncommitted tracked changes.
   */
  appBuildSha: string;
  servingEndpoint: string;
  modelName: string;
  /** The served entity version taking 100% of traffic. */
  modelVersion: string;
  /** The commit the served model version was logged from. */
  modelBuildSha: string;
  /** `user_api_scopes` as the live app declares them, sorted. */
  declaredScopes: string[];
  /**
   * The tables the model version declares as dependencies, sorted.
   *
   * This is the manifest as UNITY CATALOG holds it, which is what the serving
   * principal was actually granted, rather than what the repository intended.
   * The two disagreeing is the drift worth certifying against.
   */
  manifestTables: string[];
  /**
   * Whether the served version enforces UserAuthPolicy.
   *
   * Read from the MLflow run that logged the version, not from serving. Neither
   * `serving-endpoints get` nor the Unity Catalog model version carries the
   * policy (checked against the live demo endpoint on 2026-08-10: the endpoint
   * payload has no auth field at all, and a model version reports only its table
   * dependencies), which nearly made this a fact only a release could record.
   * `log_model.py` passes it through `model_config` and MLflow keeps every entry
   * as a run param, so it is recoverable from the version alone.
   *
   * `unknown` means the run was not readable, and is distinct from `disabled`,
   * which is a definite answer: a version logged before the key existed bakes
   * nothing and fails closed to passthrough on load.
   */
  userAuthPolicy: UserAuthPolicyState;
}

export const UNKNOWN = '';

export function emptyTuple(): ReleaseTuple {
  return {
    target: UNKNOWN,
    appName: UNKNOWN,
    appBuildSha: UNKNOWN,
    servingEndpoint: UNKNOWN,
    modelName: UNKNOWN,
    modelVersion: UNKNOWN,
    modelBuildSha: UNKNOWN,
    declaredScopes: [],
    manifestTables: [],
    userAuthPolicy: 'unknown',
  };
}

/**
 * The fields that must be known before a tuple identifies anything.
 *
 * `manifestTables` is deliberately absent: a model version with no declared
 * tables is a legitimate configuration (an agent that reads nothing), and
 * treating an empty list as unknown would make that deployment permanently
 * uncertifiable. Whether the manifest is the RIGHT one is a separate check with
 * something to compare against.
 */
const IDENTIFYING_FIELDS = [
  'target',
  'appName',
  'appBuildSha',
  'servingEndpoint',
  'modelName',
  'modelVersion',
  'modelBuildSha',
] as const;

/** Which identifying fields this tuple does not know, in a stable order. */
export function unknownFields(tuple: ReleaseTuple): string[] {
  const missing = IDENTIFYING_FIELDS.filter((field) => tuple[field].trim() === UNKNOWN);
  const all: string[] = [...missing];
  if (tuple.declaredScopes.length === 0) all.push('declaredScopes');
  return all;
}

/** Whether either build stamp records an unreproducible working tree. */
export const DIRTY_SUFFIX = '+dirty';

export function dirtyStamps(tuple: ReleaseTuple): string[] {
  return [tuple.appBuildSha, tuple.modelBuildSha].filter((sha) => sha.endsWith(DIRTY_SUFFIX));
}

/**
 * A stable digest of the tuple.
 *
 * Sorted keys and sorted lists, so a digest depends on the release rather than
 * on the order two API calls happened to return their arrays in. Sorting is done
 * on a copy: the caller's tuple is theirs, and a probe that read
 * `declaredScopes` in authored order after this had run would be reading a
 * different list from the one it was given.
 */
export function tupleDigest(tuple: ReleaseTuple): string {
  const canonical = {
    target: tuple.target,
    appName: tuple.appName,
    appBuildSha: tuple.appBuildSha,
    servingEndpoint: tuple.servingEndpoint,
    modelName: tuple.modelName,
    modelVersion: tuple.modelVersion,
    modelBuildSha: tuple.modelBuildSha,
    declaredScopes: [...tuple.declaredScopes].sort(),
    manifestTables: [...tuple.manifestTables].sort(),
    userAuthPolicy: tuple.userAuthPolicy,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Whether two tuples describe the same release. */
export function sameRelease(a: ReleaseTuple, b: ReleaseTuple): boolean {
  return tupleDigest(a) === tupleDigest(b);
}

/**
 * The tuple as printable lines.
 *
 * Unknown is rendered as `(unknown)` rather than as a blank, because a blank in
 * a column of values reads as a value nobody bothered to fill in.
 */
export function describeTuple(tuple: ReleaseTuple): string[] {
  const show = (value: string) => (value.trim() === UNKNOWN ? '(unknown)' : value);
  const list = (values: string[]) => (values.length === 0 ? '(none observed)' : values.join(', '));
  return [
    `target             ${show(tuple.target)}`,
    `app                ${show(tuple.appName)}`,
    `app build          ${show(tuple.appBuildSha)}`,
    `serving endpoint   ${show(tuple.servingEndpoint)}`,
    `model              ${show(tuple.modelName)}`,
    `model version      ${show(tuple.modelVersion)}`,
    `model build        ${show(tuple.modelBuildSha)}`,
    `declared scopes    ${list([...tuple.declaredScopes].sort())}`,
    `manifest tables    ${tuple.manifestTables.length}`,
    `user auth policy   ${tuple.userAuthPolicy}`,
    `release digest     ${tupleDigest(tuple)}`,
  ];
}
