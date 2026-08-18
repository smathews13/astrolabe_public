import { describe, expect, it } from 'vitest';
import { FAILURE_CODES, layerOf, type FailureCode } from './run-failure-codes';
import {
  canTransition,
  isTerminal,
  mayCarryAnswer,
  resumableWithoutLease,
  RUN_STATES,
  shortestPath,
  TERMINAL_CODES,
  TERMINAL_STATE_BY_LAYER,
  TERMINAL_STATES,
  terminalRefusal,
  terminalStateFor,
  TRANSITIONS,
  transitionRefusal,
  type RunState,
  type TerminalRunState,
} from './run-state';

/**
 * These are mostly properties of the whole table rather than cases.
 *
 * A per-transition test proves that the cell somebody wrote is the cell
 * somebody wrote. The failures worth catching here are structural: a state
 * nothing reaches, a state nothing leaves, a terminal state that quietly
 * gained an exit, a failure code that no terminal state accepts. Each of those
 * is invisible in a diff of one row and is exactly what a run ledger cannot
 * afford, because the transition matrix is what stops two executors owning one
 * run.
 */

const NON_TERMINAL = RUN_STATES.filter((state) => !isTerminal(state));

/** Every state reachable from RECEIVED, following TRANSITIONS. */
function reachable(): Set<RunState> {
  const seen = new Set<RunState>(['RECEIVED']);
  const queue: RunState[] = ['RECEIVED'];
  while (queue.length > 0) {
    for (const next of TRANSITIONS[queue.shift() as RunState]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('the shape of the transition table', () => {
  it('declares a row for every state and names only states in its cells', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...RUN_STATES].sort());
    for (const state of RUN_STATES) {
      for (const next of TRANSITIONS[state]) {
        expect(RUN_STATES).toContain(next);
      }
    }
  });

  it('lets nothing out of a terminal state', () => {
    // Including into another terminal state. A run that answered and is then
    // marked FAILED because a late write threw is a ledger that disagrees with
    // what the user was shown, and the fenced update cannot catch it because
    // the write is legal as far as the database is concerned.
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state]).toEqual([]);
    }
  });

  it('lets something out of every state that is not terminal', () => {
    for (const state of NON_TERMINAL) {
      expect(TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });

  it('never lets a state transition to itself', () => {
    // The fenced UPDATE matches on the state it expects to leave, so a
    // self-transition would always be accepted and would report success to a
    // second executor that had just overwritten the first.
    for (const state of RUN_STATES) {
      expect(TRANSITIONS[state]).not.toContain(state);
    }
  });

  it('lists each destination once, so a duplicated cell cannot hide a rename', () => {
    for (const state of RUN_STATES) {
      expect(new Set(TRANSITIONS[state]).size).toBe(TRANSITIONS[state].length);
    }
  });
});

describe('what the table says about a whole run', () => {
  it('can reach every state from RECEIVED', () => {
    // A state nothing reaches is dead code that reads like behaviour. It would
    // appear in the Run Explorer's legend and in the ledger's column comments
    // and never once in the data.
    expect([...reachable()].sort()).toEqual([...RUN_STATES].sort());
  });

  it('can reach a terminal state from every non-terminal one in a single step', () => {
    // Not merely eventually. Every one of these states is somewhere a run can
    // be when the deadline expires or the store goes away, and a state that
    // had to pass through another to record that would force the coordinator
    // to write a transition that did not happen.
    for (const state of NON_TERMINAL) {
      expect(TRANSITIONS[state].some(isTerminal)).toBe(true);
    }
  });

  it('can record a deadline expiry and a persistence failure wherever the run is', () => {
    for (const state of NON_TERMINAL) {
      expect(canTransition(state, 'DEADLINE_EXCEEDED')).toBe(true);
      expect(canTransition(state, 'PERSISTENCE_FAILED')).toBe(true);
    }
  });

  it('reaches SUCCEEDED only through SYNTHESIZING', () => {
    // The assembly step is where evidence validation and the typed answer
    // contract are applied. A path to SUCCEEDED that skipped it would be a way
    // to store an answer nothing had checked.
    const from = RUN_STATES.filter((state) => canTransition(state, 'SUCCEEDED'));
    expect(from).toEqual(['SYNTHESIZING']);
  });

  it('follows the plan approval loop without leaving the run', () => {
    // The agent is entitled to refuse a stale approval and re-issue, which the
    // ask route already handles as `supersededApprovalId`. It has to be
    // expressible without opening a second run, or the ledger would show two
    // runs for one question every time an approval went stale.
    expect(canTransition('AWAITING_APPROVAL', 'PLANNING')).toBe(true);
    expect(canTransition('AWAITING_APPROVAL', 'RUNNING')).toBe(true);
  });
});

describe('a refused transition', () => {
  it('says which two states it refused, so the log names the run it came from', () => {
    expect(transitionRefusal('SYNTHESIZING', 'PLANNING')).toContain('SYNTHESIZING');
    expect(transitionRefusal('SYNTHESIZING', 'PLANNING')).toContain('PLANNING');
  });

  it('calls out a write to a finished run as the stale executor it usually is', () => {
    const refusal = transitionRefusal('SUCCEEDED', 'FAILED') ?? '';
    expect(refusal).toContain('has finished');
    expect(refusal).toContain('fencing token');
  });

  it('calls out a repeat of the same transition rather than shrugging at it', () => {
    expect(transitionRefusal('RUNNING', 'RUNNING')).toContain('second executor');
  });

  it('says nothing at all when the transition is legal', () => {
    expect(transitionRefusal('PLANNING', 'RUNNING')).toBeNull();
  });
});

describe('which state may carry an answer', () => {
  it('is SUCCEEDED and nothing else', () => {
    expect(RUN_STATES.filter(mayCarryAnswer)).toEqual(['SUCCEEDED']);
  });
});

describe('terminal states and failure codes', () => {
  it('accounts for every code in the shared taxonomy exactly once', () => {
    // Both halves matter. A code no terminal state accepts cannot be recorded
    // at all, and a code two states accept has no defined `terminalStateFor`,
    // which is the function the ask route uses to decide how a run ended.
    const counted = new Map<FailureCode, number>();
    for (const state of TERMINAL_STATES) {
      for (const code of TERMINAL_CODES[state]) {
        counted.set(code, (counted.get(code) ?? 0) + 1);
      }
    }
    expect([...counted.keys()].sort()).toEqual([...FAILURE_CODES].sort());
    expect([...counted.values()].filter((count) => count !== 1)).toEqual([]);
  });

  it('resolves each code to the one state a run carrying it ends in', () => {
    for (const code of FAILURE_CODES) {
      expect(TERMINAL_CODES[terminalStateFor(code)]).toContain(code);
    }
    expect(terminalStateFor('RUN_DEADLINE_EXCEEDED')).toBe('DEADLINE_EXCEEDED');
    expect(terminalStateFor('PERSISTENCE_UNAVAILABLE')).toBe('PERSISTENCE_FAILED');
    expect(terminalStateFor('STREAM_INTERRUPTED')).toBe('FAILED');
  });

  it('keeps every denial in REFUSED rather than in FAILED', () => {
    // The distinction the taxonomy exists to hold. A denial filed as FAILED is
    // read as an outage, alerts as one, and invites the retry that would ask
    // the same question under a more privileged identity. Read off the layer
    // rather than off a list of codes, for the same reason the source is: a
    // code added to the taxonomy tomorrow is covered by this case today.
    const denials = FAILURE_CODES.filter((code) =>
      (['identity', 'authorization', 'governance'] as string[]).includes(layerOf(code))
    );
    expect(denials.length).toBeGreaterThan(0);
    for (const code of denials) {
      expect(terminalStateFor(code)).toBe('REFUSED');
    }
  });

  it('never files a denial under a state a retry loop would act on', () => {
    // The property behind the case above, stated so it survives the layers
    // being reshuffled: whatever else changes, no layer the taxonomy forbids
    // rerouting through may land in FAILED, which is the state an operator
    // reads as an outage and a retry reads as worth another go.
    for (const layer of ['identity', 'authorization', 'governance'] as const) {
      expect(TERMINAL_STATE_BY_LAYER[layer]).toBe('REFUSED');
    }
  });

  it('refuses a code that belongs to a different terminal state, and names that state', () => {
    const refusal = terminalRefusal('FAILED', 'USER_NOT_AUTHORIZED') ?? '';
    // The converged taxonomy separates authorization from identity: "we could
    // not accept who you are" and "we accepted who you are and you lack the
    // grant" have different remedies and different alert severities.
    expect(refusal).toContain('authorization-layer');
    expect(refusal).toContain('REFUSED');
  });

  it('refuses a failure with no code, because the operator is left nothing to act on', () => {
    expect(terminalRefusal('FAILED', null)).toContain('must carry a failure code');
  });

  it('refuses a code on an outcome that did not fail', () => {
    for (const state of ['SUCCEEDED', 'CLARIFICATION_REQUIRED', 'CANCELLED'] satisfies TerminalRunState[]) {
      expect(terminalRefusal(state, 'DEPENDENCY_UNAVAILABLE')).toContain('did not fail');
      expect(terminalRefusal(state, null)).toBeNull();
    }
  });

  it('accepts the pairings the ask route will actually write', () => {
    expect(terminalRefusal('DEADLINE_EXCEEDED', 'RUN_DEADLINE_EXCEEDED')).toBeNull();
    expect(terminalRefusal('PERSISTENCE_FAILED', 'PERSISTENCE_UNAVAILABLE')).toBeNull();
    expect(terminalRefusal('FAILED', 'STREAM_INTERRUPTED')).toBeNull();
    expect(terminalRefusal('REFUSED', 'NO_VALID_EVIDENCE')).toBeNull();
  });
});

describe('taking over a run that already exists', () => {
  it('picks up the states where nothing is in flight', () => {
    expect(RUN_STATES.filter(resumableWithoutLease)).toEqual(['RECEIVED', 'AWAITING_APPROVAL']);
  });

  it('never picks up a finished run, which is what makes a reconnect cheap', () => {
    for (const state of TERMINAL_STATES) {
      expect(resumableWithoutLease(state)).toBe(false);
    }
  });

  it('never picks up a run mid-flight without going through the lease', () => {
    // The lease, not this predicate, is what decides whether an executor that
    // stopped reporting has really gone. Answering true here for RUNNING would
    // hand the run to a second executor while the first was still calling
    // Genie, which is the duplicate execution this workstream exists to stop.
    for (const state of ['PLANNING', 'RUNNING', 'SYNTHESIZING'] satisfies RunState[]) {
      expect(resumableWithoutLease(state)).toBe(false);
    }
  });
});

describe('walking a run to a state the caller only knows the end of', () => {
  it('takes the route an answer has to have taken', () => {
    expect(shortestPath('RECEIVED', 'SUCCEEDED')).toEqual(['PLANNING', 'RUNNING', 'SYNTHESIZING', 'SUCCEEDED']);
  });

  it('goes straight to a failure any state can reach', () => {
    expect(shortestPath('RECEIVED', 'FAILED')).toEqual(['FAILED']);
    expect(shortestPath('RUNNING', 'DEADLINE_EXCEEDED')).toEqual(['DEADLINE_EXCEEDED']);
  });

  it('walks nowhere when it is already there', () => {
    expect(shortestPath('RUNNING', 'RUNNING')).toEqual([]);
  });

  it('reports that nothing leaves a terminal state rather than inventing a way out', () => {
    for (const state of TERMINAL_STATES) {
      for (const to of TERMINAL_STATES) {
        // Except to itself, which is not a way out: it is no work to do, and a
        // caller settling a run that is already settled must write nothing
        // rather than re-mark a run the reader has already been answered from.
        if (state === to) continue;
        expect(shortestPath(state, to)).toBeNull();
      }
    }
  });

  it('only ever returns steps the matrix allows', () => {
    // The property that matters. Any pair, and every step of the path it
    // returns is a legal transition, so a caller cannot be handed a walk the
    // ledger will refuse halfway through and leave a run stranded mid-flight.
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        const path = shortestPath(from, to);
        if (path === null) continue;
        let previous = from;
        for (const step of path) {
          expect(canTransition(previous, step)).toBe(true);
          previous = step;
        }
      }
    }
  });

  it('reaches every terminal state from a run that has only just been received', () => {
    // The case the ask route depends on. In shadow mode the route records a run
    // and nothing else until the turn ends, so a run that cannot be walked from
    // RECEIVED to how it actually ended is a run left in flight forever.
    for (const to of TERMINAL_STATES) {
      expect(shortestPath('RECEIVED', to)).not.toBeNull();
    }
  });

  it('will not walk a synthesising run back to a clarification', () => {
    // Not an oversight in the matrix. An agent that has begun assembling an
    // answer has decided the question was answerable, and a run that ends by
    // asking the reader what they meant did not get that far.
    expect(shortestPath('SYNTHESIZING', 'CLARIFICATION_REQUIRED')).toBeNull();
  });
});
