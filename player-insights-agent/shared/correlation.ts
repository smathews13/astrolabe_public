/**
 * The one id that names a question everywhere it is recorded.
 *
 * Six systems record something about a single ask -- the app's own log, the run
 * ledger in Lakebase, the model serving span, the Genie conversation, the Vector
 * Search query, and the MLflow trace -- and until this existed each named it
 * something different. Diagnosing one slow or wrong answer meant matching rows
 * by timestamp across all six, which works until two people ask at once.
 *
 * WHY THE BROWSER MINTS IT AND NOT THE SERVER. The failure that most needs a
 * correlation id is the one where the server never answers: a release replaces
 * the app mid-question and `fetch` rejects with no status, no body and no id
 * (see `AskUnreachable` in client/src/ask-stream.ts). A server-minted id exists
 * only in a response that never arrived. An id minted before the request leaves
 * is in the browser's hands whatever happens to the server, and the server
 * logged it on the way in, so the two can still be joined afterwards.
 *
 * WHY IT IS NOT THE RUN'S PRIMARY KEY, WHICH IS THE IMPORTANT PART. The run
 * ledger's `run_id` stays minted by the server. A caller-supplied value used as
 * a primary key lets a caller name a row: `createOrGetRun` inserts on
 * `run_id`, so a client replaying somebody else's id conflicts with their row,
 * and the read that follows is scoped to the caller's own email and finds
 * nothing -- three retries and a self-inflicted denial. That is not a data leak,
 * and it is still a caller reaching a table it has no business addressing. So
 * the two ids are deliberately separate: `run_id` is a database key, and this is
 * the identifier every human-facing and cross-system record carries. When the
 * browser sends nothing usable they hold the same value, which is what the app
 * did before this module and why nothing regresses without it.
 */

/**
 * The header the browser sends it on.
 *
 * `x-` prefixed and app-specific rather than one of the tracing conventions
 * (`traceparent`, `X-Request-ID`). Databricks Apps sits behind a proxy that
 * sets and rewrites headers of its own, and a name that collides with one it
 * manages is a name that arrives changed or not at all.
 */
export const CORRELATION_HEADER = 'x-pia-correlation-id';

/** Distinguishes ours in a log line that also carries platform ids. */
export const CORRELATION_PREFIX = 'req-';

/**
 * A hyphenated lowercase UUID, and nothing else, after the prefix.
 *
 * STRICT BECAUSE THE VALUE IS PRINTED AND STORED. It goes into server log lines,
 * into a Lakebase column, into a trace attribute and back to the browser in a
 * refusal body. A caller-controlled string in a log line can forge a line; one
 * in a trace attribute can carry a question's text back out of a system that
 * deliberately does not record questions. A UUID shape can do neither, and a
 * client that cannot produce one gets a server-minted id rather than an error --
 * there is nothing here worth failing a question over.
 */
const CORRELATION_SHAPE = /^req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A fresh id. The same function on both sides of the wire, deliberately. */
export function mintCorrelationId(): string {
  return `${CORRELATION_PREFIX}${crypto.randomUUID()}`;
}

/**
 * The caller's id if it is one we will print, otherwise null.
 *
 * Null is ordinary: a `curl`, an older browser build, and the benchmark runner
 * all send nothing. The caller is never told, because a rejected correlation id
 * changes nothing about whether their question can be answered.
 */
export function usableCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return CORRELATION_SHAPE.test(trimmed) ? trimmed : null;
}
