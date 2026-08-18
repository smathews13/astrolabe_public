/**
 * The run ledger's one door onto the shared failure taxonomy.
 *
 * WHY THE INDIRECTION. `shared/failure-taxonomy.ts` is owned by the terminal
 * contract workstream and is being written at the same time as this one. It has
 * already been reshaped once underneath this code (the definition table was
 * called `FAILURES` in the morning and `FAILURE_TAXONOMY` by the afternoon,
 * with a different set of layers), and the ledger touches codes in enough
 * places that chasing a rename through all of them is how the two halves come
 * to disagree about what a code means. Everything in the ledger imports from
 * here instead, so a rename over there is a change to this file and nothing
 * else.
 *
 * This is NOT a second taxonomy. It declares no codes, no messages and no
 * statuses of its own, and it must not grow any: a code the ledger needs and
 * the taxonomy does not have is a failure nobody has agreed the meaning of yet,
 * and the shared file is where it gets agreed.
 */

import {
  FAILURE_CODES,
  failureDefinition,
  isFailureCode,
  type FailureCode,
  type FailureDefinition,
  type FailureLayer,
} from '../../shared/failure-taxonomy';

export { FAILURE_CODES, failureDefinition, isFailureCode };
export type { FailureCode, FailureDefinition, FailureLayer };

/** Which part of the request a code belongs to. */
export function layerOf(code: FailureCode): FailureLayer {
  return failureDefinition(code).layer;
}

/** The sentence a reader is shown for this outcome. */
export function messageOf(code: FailureCode): string {
  return failureDefinition(code).uiMessage;
}

/** What the API answers with. Chosen by the taxonomy, never by the ledger. */
export function statusOf(code: FailureCode): number {
  return failureDefinition(code).httpStatus;
}
