/**
 * OAuth scopes that improve Connections / Ops metadata probes and the
 * Connections pickers, but are not required for asks (Genie's SQL / serving
 * path).
 *
 * Always listed in the login gate and Identity card as Optional — including on
 * customer deploys that do not declare them — so a reader can see the capability
 * without treating a shortfall as a hard gate. Declaring them (example) still puts
 * them on the app's OAuth consent; leaving them off (customer default) does not.
 *
 * Vector Search scopes are NOT in this set. On a deployment with a semantic
 * index they are required for asks under user auth; customer default correctly
 * omits them until semantic opt-in.
 */
export const OPTIONAL_USER_API_SCOPES = [
  'catalog.catalogs:read',
  'catalog.schemas:read',
  'catalog.tables:read',
  // Workspace object listing, for the Connections notebook picker. Optional on
  // the same terms as the three above: without it a reader types the path
  // instead, and no ask is affected. The name is the Apps API's, which refuses
  // the bare `workspace` the OAuth server advertises.
  'workspace.workspace:read',
] as const;

export type OptionalUserApiScope = (typeof OPTIONAL_USER_API_SCOPES)[number];

export function isOptionalUserApiScope(name: string): boolean {
  return (OPTIONAL_USER_API_SCOPES as readonly string[]).includes(name);
}

/** Declared shortfalls that still gate the login verdict / sign-in remedy. */
export function requiredMissingScopes(missing: readonly string[]): string[] {
  return missing.filter((name) => name && !isOptionalUserApiScope(name));
}
