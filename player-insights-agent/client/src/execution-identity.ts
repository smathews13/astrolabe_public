/**
 * Naming a principal, and the gate's own account of what it verified, in the
 * few places either is printed.
 *
 * This module used to carry the copy for a status strip above every page as
 * well: a label and a tone per access mode. The strip is gone (see AccessGate),
 * and the labels went with it rather than being left here for a caller who no
 * longer exists. What survives is the part other surfaces still need — an
 * identifier shortened to something safe to print, and the verification detail
 * with any repeat of it abbreviated — which the Connections page and the
 * conversation rail both use.
 */

/**
 * The verification detail with any repeat of the principal's id abbreviated.
 */
export function withoutRepeatedPrincipal(detail: string, principal: string | null | undefined): string {
  const id = principal?.trim();
  if (!id || !detail) return detail;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return detail.replace(new RegExp(escaped, 'gi'), principalLabel(id));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A run of hex long enough that nobody chose it.
 *
 * Tested in addition to the uuid shape rather than instead of it, because not
 * every opaque principal is well-formed: Model Serving has handed back ids that
 * are uuid-ish without being uuids, and treating one of those as a display name
 * would print almost all of it wherever the label is shown. Eight
 * is the width of a uuid's first segment, short enough that no word reaches it,
 * long enough that a hyphenated name like `player-insights-serving-sp` does not.
 */
const HEX_RUN = /[0-9a-f]{8}/i;

/** Longest name shown in full. Past this it is truncated rather than wrapped. */
const NAME_LIMIT = 28;

/**
 * A principal, short enough to sit in a row beside other fields.
 */
export function principalLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (isOpaqueId(trimmed)) return `${trimmed.slice(0, 8)}\u2026`;
  if (trimmed.length > NAME_LIMIT) return `${trimmed.slice(0, NAME_LIMIT - 1)}\u2026`;
  return trimmed;
}

/**
 * Whether a value is safe to print in full.
 */
export function isOpaqueId(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? '';
  return UUID.test(trimmed) || HEX_RUN.test(trimmed);
}
