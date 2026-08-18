/**
 * Refuse to run the boot DDL against a schema somebody else owns.
 *
 * WHY THIS EXISTS. A local development server, pointed at the Lakebase branch
 * the deployed app uses, boots and runs the same DDL the app runs. Every
 * statement is `IF NOT EXISTS`, so it looks harmless, and for the tables that
 * already exist it is: Postgres refuses them on ownership and the app logs that
 * it did. But a table the DDL has just LEARNED about does not exist yet, so
 * there is nothing to refuse -- it is created, and the developer's own role owns
 * it forever.
 *
 * That is not a hypothetical either. Three admin tables were added to the DDL,
 * a local server booted against the live branch, and the deployment was blocked
 * by the release's ownership gate: the app could not maintain three of its own
 * tables, and ownership cannot be handed over, because `ALTER ... OWNER TO`
 * needs `SET ROLE` on the target and Lakebase does not grant a human that over a
 * service principal. The only remedy left was to drop the tables and let the app
 * recreate them, which is survivable for three empty tables and would not be for
 * anything holding rows.
 *
 * SO THE GUARD IS PLACED AT THE MOMENT OF DAMAGE rather than in a runbook. A
 * documented step is followed by whoever read the document; this is followed by
 * whoever runs the server. It costs one query per boot.
 *
 * IT MUST NOT REFUSE THE THREE LEGITIMATE CASES, which is why the condition is
 * narrow:
 *
 * - The deployed app. Connects as its own service principal, which owns the
 *   schema, so it proceeds.
 * - Local development against a branch of one's own. The developer owns the
 *   schema they created, so it proceeds.
 * - A fresh branch, or a fresh deployment. The schema does not exist, so
 *   whoever runs the DDL first creates and owns it, and it proceeds.
 *
 * Only the fourth case is refused: the schema exists, and the role connecting
 * has no rights over the role that owns it. That role cannot maintain the schema
 * it is about to add to, and every object it creates is one more the owner
 * cannot maintain either.
 */

/** What Postgres says about the schema and who is asking. */
export interface SchemaOwnership {
  /** Whether the schema is already there. Absent means nothing to protect. */
  schemaExists: boolean;
  /** The role that owns it, as `pg_get_userbyid(nspowner)` reports it. */
  owner: string;
  /** The role the app is connected as, per `current_user`. */
  connectedRole: string;
  /**
   * Whether the connected role holds the owner's rights, per `pg_has_role(...,
   * 'USAGE')`. Asked rather than inferred from the two names being equal,
   * because a role that is a member of the owner can maintain the schema
   * perfectly well and refusing it would be a false alarm.
   */
  connectedRoleHoldsOwner: boolean;
}

/**
 * Why the DDL must not run, or '' when it may.
 *
 * A sentence rather than a boolean, because the caller logs it and the reader of
 * that log needs to know which of the two roles is which and what to change. An
 * empty string is the only "proceed" value, so a caller cannot accidentally
 * treat a reason as truthy-safe.
 */
export function schemaWriteRefusal(schema: string, state: SchemaOwnership): string {
  if (!state.schemaExists) return '';
  if (state.connectedRoleHoldsOwner) return '';
  return (
    `${schema} is owned by ${state.owner} and this server is connected as ${state.connectedRole}, ` +
    `which holds none of that role's rights. The boot DDL is NOT being run. ` +
    `Statements against the tables that already exist would be refused on ownership anyway, but any ` +
    `table this version has ADDED would be created successfully and owned by ${state.connectedRole} ` +
    `forever -- which is what blocks the next release, because ownership cannot be handed back: ` +
    `ALTER ... OWNER TO needs SET ROLE on the owner and Lakebase does not grant that. ` +
    `If this is a local development server, it is pointed at the deployed app's branch: give it a ` +
    `branch of its own and it will own its own schema. If this IS the deployed app, its Postgres role ` +
    `has changed since the schema was created, and the schema has to be recreated by the new role.`
  );
}

/**
 * The one query behind {@link SchemaOwnership}.
 *
 * `to_regnamespace` rather than a `pg_namespace` lookup with a row-count check,
 * so the absent case comes back as a null in a single row rather than as no rows
 * at all -- one shape for the caller to read instead of two.
 */
export function schemaOwnershipQuery(): string {
  return `SELECT to_regnamespace($1) IS NOT NULL AS schema_exists,
                 COALESCE(pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = $1)), '') AS owner,
                 current_user AS connected_role,
                 COALESCE(
                   pg_has_role(current_user,
                               (SELECT nspowner FROM pg_namespace WHERE nspname = $1),
                               'USAGE'),
                   false) AS connected_role_holds_owner`;
}
