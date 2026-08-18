/**
 * The three primitives every role decision needs, in a module that imports nothing.
 *
 * A LEAF ON PURPOSE. Role resolution needs the roster, and the roster needs the
 * address normaliser and the column reader, and both of those used to live in
 * admin-roles.ts -- which made the two modules import each other. A cycle between
 * two files that decide permissions is a cycle whose evaluation order decides
 * permissions, so the shared bottom is split out instead. admin-roles.ts re-exports
 * all three, so nothing that imported them from there has to change.
 */

/** The narrow slice of Lakebase a role decision needs, so a test can pass an object. */
export interface AdminStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * One address, in the form the comparison is made in.
 *
 * Lowercased, because a person who signs in as `A.Person@example.com` and was added
 * as `a.person@example.com` is one person, and a role check that says otherwise is a
 * lockout nobody can diagnose from the screen. Trimmed, because a comma-separated
 * environment variable is written by a human.
 */
export function normalizeAdminEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * One column of one row, as text.
 *
 * A row's columns arrive typed as `unknown`, and `String()` on an object produces
 * "[object Object]", which would put that string on the settings screen as
 * somebody's email address. Anything that is not a scalar reads as absent instead.
 */
export function columnText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}
