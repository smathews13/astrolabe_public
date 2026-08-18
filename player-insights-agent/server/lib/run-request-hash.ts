/**
 * What makes two asks the same ask.
 *
 * Pure, and deliberately so: this decides whether a second request attaches to
 * an existing run or starts a new one, which means a bug here either duplicates
 * expensive model and tool work or, far worse, answers one question with
 * another question's run. Neither is findable by reading the ask route.
 *
 * The hash is computed AFTER the owned conversation and attachment context has
 * been loaded, not from the request body. The body is the same on the second
 * and third turn of a conversation whenever the user asks the same short
 * follow-up ("and last month?"), and those are different questions with
 * different answers. What distinguishes them is the history they run against,
 * so the history is in the hash.
 */

import { createHash } from 'node:crypto';

/**
 * Everything that changes the answer, and nothing that does not.
 *
 * Two fields are conspicuously absent and their absence is load-bearing:
 *
 *  - The client's request id and any timestamp. Including either would make
 *    every request unique, which is a hash that compiles, passes a naive test,
 *    and silently turns idempotency off in production.
 *  - Whether the caller wanted SSE. The plan is explicit that a transport
 *    fallback must attach to the same run rather than start a second one, and
 *    the transport is exactly what differs between the two attempts of the
 *    truncated-stream retry this workstream exists to remove.
 */
export interface CanonicalRequest {
  /** Scopes every hash to one reader. See the note on `canonicalRequestHash`. */
  userEmail: string;
  conversationId: string;
  /** The question as typed. Normalised below rather than by the caller. */
  prompt: string;
  /**
   * The owned history this turn will run against, oldest first.
   *
   * Order is significant and is preserved. Two conversations holding the same
   * turns in a different order are different contexts, and a hash that sorted
   * them would call them one run.
   */
  history: { role: string; content: string }[];
  /**
   * The attachments in scope, by filename and extracted text.
   *
   * The text and not just the name: replacing a PDF with a different PDF of
   * the same name is the case where a name-only hash would answer the new
   * question with the old run's answer.
   */
  attachments: { filename: string; text: string }[];
  /** The plan this turn is authorised to execute, if any. */
  approvedPlanId?: string;
  executePlan?: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Collapses runs of whitespace and trims.
 *
 * Applied to the prompt and to history content because a trailing newline is
 * not a different question, and a browser that trims on paste while curl does
 * not would otherwise make the two clients disagree about run identity for
 * input a human would call identical. NOT lowercased and NOT stripped of
 * punctuation: those change meaning, and a hash is the wrong place to decide
 * that two differently-worded questions are the same one.
 */
function normaliseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Serialises to a form where every field is length-prefixed.
 *
 * `JSON.stringify` of an object would do for a fixed shape, but the fields here
 * are user-supplied strings, and concatenating them is how a hash gets
 * confused: a prompt ending in a delimiter can be made to hash identically to a
 * different prompt with a different history. Length prefixes make that
 * impossible without needing the delimiter to be unguessable.
 */
function field(label: string, value: string): string {
  return `${label}:${value.length}:${value}\n`;
}

/**
 * The hash two identical asks share and two different asks do not.
 *
 * Includes the reader's own address, which looks redundant next to the
 * per-user uniqueness constraint on the ledger table and is not. The plan
 * requires that cross-user reuse of a run or key is DENIED rather than merely
 * unlikely, and a hash shared across users would let the denial rest entirely
 * on a WHERE clause that somebody could later forget. With the address inside
 * the hash, two users asking the identical question of the identical
 * conversation still produce two different hashes, so a missing predicate
 * fails to match instead of matching the wrong person's run.
 */
export function canonicalRequestHash(request: CanonicalRequest): string {
  const parts = [
    // Versioned, so a future change to what goes into the hash does not
    // silently attach new requests to runs computed under the old rules. A
    // bumped version simply misses, which starts a fresh run: the safe
    // direction.
    field('v', '1'),
    field('user', request.userEmail.trim().toLowerCase()),
    field('conversation', request.conversationId),
    field('prompt', normaliseText(request.prompt)),
    field('plan', request.approvedPlanId ?? ''),
    field('execute', request.executePlan ? 'true' : 'false'),
    field('turns', String(request.history.length)),
    ...request.history.flatMap((turn) => [field('role', turn.role), field('content', normaliseText(turn.content))]),
    field('files', String(request.attachments.length)),
    ...request.attachments.flatMap((file) => [
      field('filename', file.filename),
      // Hashed rather than included: an attachment's extracted text runs to
      // hundreds of kilobytes, and the whole conversation's worth would be
      // rehashed on every turn.
      field('text', sha256(file.text)),
    ]),
  ];
  return sha256(parts.join(''));
}

/**
 * The stored form of a caller's `Idempotency-Key`.
 *
 * Hashed with the reader's address rather than stored raw, for two reasons that
 * both matter. The key is chosen by the client and has been known to carry
 * content (people use the question itself), so the raw value is user data this
 * table has no reason to hold. And binding it to the address means one user's
 * key cannot collide with another's: the plan requires cross-user reuse of a
 * key to be denied, and this makes the denial structural rather than a
 * predicate somebody has to remember to write.
 */
export function idempotencyKeyHash(userEmail: string, key: string): string {
  return sha256(field('v', '1') + field('user', userEmail.trim().toLowerCase()) + field('key', key));
}

/**
 * Whether a caller-supplied key is one this app will accept.
 *
 * Bounded because it is stored, and restricted to characters that survive a
 * header, a log line and a URL unchanged. Rejected keys are answered as a bad
 * request rather than ignored: a client that thinks it sent an idempotency key
 * and did not is a client that believes it is protected from duplicate
 * execution and is not.
 */
export function isUsableIdempotencyKey(key: string): boolean {
  return /^[A-Za-z0-9._:-]{8,200}$/.test(key);
}
