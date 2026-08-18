import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLakebaseHealth, stopLakebaseWatchdog } from './lakebase-store';
import { FakeStore } from './__fixtures__/fake-run-store';
import {
  admitRun,
  parkRun,
  releaseIdentity,
  resolveRunLedgerMode,
  settleRun,
  type AdmissionInput,
  type RunLedgerMode,
} from './run-admission';
import { messageOf, statusOf } from './run-failure-codes';
import { terminalStateFor } from './run-state';
import type { CanonicalRequest } from './run-request-hash';

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    userEmail: 'reader@example.com',
    conversationId: 'conv-1',
    prompt: 'Which titles lost the most weekly active players last month?',
    history: [],
    attachments: [],
    ...overrides,
  };
}

function input(mode: RunLedgerMode, overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    mode,
    runId: 'run-1',
    turnId: 'turn-1',
    idempotencyKey: '',
    request: request(),
    identityModeRequested: 'signed_in_user',
    releaseIdentity: { app_build_sha: 'abc123' },
    correlationId: 'req-deadbeef-0000-4000-8000-000000000001',
    budgetMs: 90_000,
    executor: 'container-a',
    ...overrides,
  };
}

let store: FakeStore;

beforeEach(() => {
  resetLakebaseHealth();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = new FakeStore();
});

afterEach(() => {
  stopLakebaseWatchdog();
  vi.restoreAllMocks();
});

describe('reading the mode', () => {
  it('defaults to shadow when nothing is set', () => {
    expect(resolveRunLedgerMode(undefined)).toBe('shadow');
    expect(resolveRunLedgerMode('')).toBe('shadow');
  });

  it('reads the three modes case-insensitively, because bundle variables are typed by hand', () => {
    expect(resolveRunLedgerMode('off')).toBe('off');
    expect(resolveRunLedgerMode('Shadow')).toBe('shadow');
    expect(resolveRunLedgerMode(' ENFORCE ')).toBe('enforce');
  });

  it('treats a value it does not recognise as shadow rather than enforce', () => {
    // The direction matters more than the default. A typo must not be the thing
    // that starts refusing customer requests.
    expect(resolveRunLedgerMode('enforced')).toBe('shadow');
    expect(resolveRunLedgerMode('true')).toBe('shadow');
  });

  it('says so when it does not recognise the value', () => {
    resolveRunLedgerMode('enforc');
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('PIA_RUN_LEDGER');
  });
});

describe('admitting a question with the ledger off', () => {
  it('writes nothing at all', async () => {
    const admission = await admitRun(store, input('off'));

    expect(admission.kind).toBe('proceed');
    expect(store.statements).toHaveLength(0);
  });

  it('lets a finish call pass without a run to finish', async () => {
    const admission = await admitRun(store, input('off'));
    await settleRun(store, admission, { to: 'SUCCEEDED' });

    expect(store.statements).toHaveLength(0);
  });
});

describe('admitting a question in shadow mode', () => {
  it('records the run and leases it', async () => {
    const admission = await admitRun(store, input('shadow'));

    expect(admission.kind).toBe('proceed');
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].lease_owner).toBe('container-a');
    expect(admission.kind === 'proceed' && admission.fencingToken).toBe(1);
  });

  it('opens an attempt row so a run stuck mid-flight names the container holding it', async () => {
    await admitRun(store, input('shadow'));

    expect(store.attempts).toHaveLength(1);
    expect(store.attempts[0].executor).toBe('container-a');
  });

  it('proceeds anyway when the ledger cannot record the run', async () => {
    // The whole reason for running this way first: find out what the ledger
    // would have done without anybody's question failing because of it.
    store.failWith = 'relation "player_insights.runs" does not exist';

    const admission = await admitRun(store, input('shadow'));

    expect(admission.kind).toBe('proceed');
    expect(admission.kind === 'proceed' && admission.run).toBeNull();
  });

  it('proceeds when the same question is already running, and says what enforce would have done', async () => {
    await admitRun(store, input('shadow'));

    const second = await admitRun(store, input('shadow', { runId: 'run-2', executor: 'container-b' }));

    expect(second.kind).toBe('proceed');
    expect(store.runs).toHaveLength(1);
    const warnings = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes('enforce'))).toBe(true);
  });

  it('never refuses a duplicate idempotency key, however wrong the content is', async () => {
    await admitRun(store, input('shadow', { idempotencyKey: 'client-key-0001' }));

    const second = await admitRun(
      store,
      input('shadow', {
        runId: 'run-2',
        idempotencyKey: 'client-key-0001',
        request: request({ prompt: 'A completely different question' }),
      })
    );

    expect(second.kind).toBe('proceed');
  });
});

describe('admitting a question in enforce mode', () => {
  it('refuses a second executor for a question already in flight', async () => {
    await admitRun(store, input('enforce'));

    const second = await admitRun(store, input('enforce', { runId: 'run-2', executor: 'container-b' }));

    expect(second.kind).toBe('refuse');
    expect(second.kind === 'refuse' && second.code).toBe('STREAM_INTERRUPTED');
    expect(second.kind === 'refuse' && second.runId).toBe('run-1');
    expect(store.runs).toHaveLength(1);
  });

  it('refuses a reused key carrying a different question, rather than replaying the old answer', async () => {
    await admitRun(store, input('enforce', { idempotencyKey: 'client-key-0001' }));

    const second = await admitRun(
      store,
      input('enforce', {
        runId: 'run-2',
        idempotencyKey: 'client-key-0001',
        request: request({ prompt: 'A completely different question' }),
      })
    );

    expect(second.kind).toBe('refuse');
    expect(second.kind === 'refuse' && second.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(second.kind === 'refuse' && second.status).toBe(409);
  });

  it('replays a finished run rather than paying for it twice', async () => {
    const first = await admitRun(store, input('enforce', { idempotencyKey: 'client-key-0001' }));
    await settleRun(store, first, { to: 'SUCCEEDED', messageId: 'msg-1' });

    const second = await admitRun(store, input('enforce', { runId: 'run-2', idempotencyKey: 'client-key-0001' }));

    expect(second.kind).toBe('replay');
    expect(second.kind === 'replay' && second.run.terminalMessageId).toBe('msg-1');
    expect(store.attempts).toHaveLength(1);
  });

  it('refuses when the run cannot be recorded, because an answer nobody can look up is the thing being prevented', async () => {
    store.failWith = 'Connection terminated unexpectedly';

    const admission = await admitRun(store, input('enforce'));

    expect(admission.kind).toBe('refuse');
    expect(admission.kind === 'refuse' && admission.code).toBe('PERSISTENCE_UNAVAILABLE');
    expect(admission.kind === 'refuse' && admission.status).toBe(503);
  });
});

describe('an idempotency key the server cannot use', () => {
  it.each([['short'], ['has spaces in it'], ['key/with/slashes']])('refuses %s in every mode', async (key) => {
    // Refused even in shadow, because this one is about the CALLER's belief. A
    // client that thinks it is protected against duplicate execution and is not
    // can only be told now.
    for (const mode of ['shadow', 'enforce'] as const) {
      const admission = await admitRun(store, input(mode, { idempotencyKey: key }));
      expect(admission.kind).toBe('refuse');
      expect(admission.kind === 'refuse' && admission.status).toBe(400);
    }
    expect(store.statements).toHaveLength(0);
  });

  it('refuses it as a malformed key rather than as a conflict, because nothing was compared', async () => {
    // The condition this used to share a code with needs an earlier request to
    // exist. Here there is none: the store was never touched.
    const admission = await admitRun(store, input('shadow', { idempotencyKey: 'short' }));

    expect(admission.kind === 'refuse' && admission.code).toBe('IDEMPOTENCY_KEY_MALFORMED');
    expect(admission.kind === 'refuse' && admission.runId).toBeNull();
    expect(store.statements).toHaveLength(0);
  });

  it('still says what a well-formed header looks like, now from the taxonomy', async () => {
    const admission = await admitRun(store, input('shadow', { idempotencyKey: 'short' }));

    expect(admission.kind === 'refuse' && admission.detail).toBe(messageOf('IDEMPOTENCY_KEY_MALFORMED'));
    expect(admission.kind === 'refuse' && admission.detail).toContain('8 to 200 characters');
  });

  it('is not refused when the ledger is off, because nothing claimed to honour it', async () => {
    const admission = await admitRun(store, input('off', { idempotencyKey: 'x' }));
    expect(admission.kind).toBe('proceed');
  });
});

/**
 * The two idempotency refusals, which a reader meeting them cold will want to
 * merge, and which the ledger itself held as ONE code with two hardcoded
 * statuses until this pair of tests existed.
 *
 * The status is the part that must not be re-decided here. A code carries
 * exactly one, the taxonomy declares it, and a status written beside a code at
 * a call site is a status that can drift from it silently.
 */
describe('the two idempotency refusals cannot be collapsed into one', () => {
  it('gives them different codes and the statuses their codes declare', async () => {
    const malformed = await admitRun(store, input('enforce', { idempotencyKey: 'no' }));

    await admitRun(store, input('enforce', { idempotencyKey: 'client-key-0001' }));
    const conflict = await admitRun(
      store,
      input('enforce', {
        runId: 'run-2',
        idempotencyKey: 'client-key-0001',
        request: request({ prompt: 'A completely different question' }),
      })
    );

    expect(malformed.kind === 'refuse' && malformed.code).toBe('IDEMPOTENCY_KEY_MALFORMED');
    expect(conflict.kind === 'refuse' && conflict.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(malformed.kind === 'refuse' && malformed.status).toBe(400);
    expect(conflict.kind === 'refuse' && conflict.status).toBe(409);
  });

  it('takes both statuses from the taxonomy rather than choosing them here', async () => {
    // The assertion that survives a change to either status: if somebody moves
    // a code's status in the shared table and the ledger keeps answering the
    // old one, this fails while the pair of literals above still passes.
    const malformed = await admitRun(store, input('enforce', { idempotencyKey: 'no' }));

    await admitRun(store, input('enforce', { idempotencyKey: 'client-key-0001' }));
    const conflict = await admitRun(
      store,
      input('enforce', {
        runId: 'run-2',
        idempotencyKey: 'client-key-0001',
        request: request({ prompt: 'A completely different question' }),
      })
    );

    expect(malformed.kind === 'refuse' && malformed.status).toBe(statusOf('IDEMPOTENCY_KEY_MALFORMED'));
    expect(conflict.kind === 'refuse' && conflict.status).toBe(statusOf('IDEMPOTENCY_CONFLICT'));
    expect(statusOf('IDEMPOTENCY_KEY_MALFORMED')).not.toBe(statusOf('IDEMPOTENCY_CONFLICT'));
  });

  /**
   * Both are `request`-layer, so both end in REFUSED. That is what they share,
   * and sharing it is not a reason to share a code.
   */
  it('ends both in REFUSED rather than blaming the app for the caller header', () => {
    expect(terminalStateFor('IDEMPOTENCY_KEY_MALFORMED')).toBe('REFUSED');
    expect(terminalStateFor('IDEMPOTENCY_CONFLICT')).toBe('REFUSED');
  });
});

describe('closing a run out', () => {
  it('marks the run and its attempt', async () => {
    const admission = await admitRun(store, input('shadow'));
    await settleRun(store, admission, { to: 'SUCCEEDED', traceId: 'tr-1', messageId: 'msg-1' });

    expect(store.runs[0].state).toBe('SUCCEEDED');
    expect(store.runs[0].trace_id).toBe('tr-1');
    expect(store.attempts[0].outcome).toBe('SUCCEEDED');
  });

  it('carries the failure code onto both the run and the attempt', async () => {
    const admission = await admitRun(store, input('shadow'));
    await settleRun(store, admission, { to: 'FAILED', code: 'DEPENDENCY_UNAVAILABLE' });

    expect(store.runs[0].state).toBe('FAILED');
    expect(store.runs[0].terminal_code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(store.attempts[0].failure_code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('logs rather than throws when the run cannot be closed, since the reader already has the answer', async () => {
    const admission = await admitRun(store, input('shadow'));
    store.failWith = 'Connection terminated unexpectedly';

    await expect(settleRun(store, admission, { to: 'FAILED' })).resolves.toBeUndefined();
    const errors = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(errors.some((line) => line.includes('no durable terminal state'))).toBe(true);
  });

  it('walks the states an answer must have passed through, since the route cannot observe them', async () => {
    const admission = await admitRun(store, input('shadow'));
    await settleRun(store, admission, { to: 'SUCCEEDED', messageId: 'msg-1' });

    const walked = store.events.map((event) => event.to);
    expect(walked).toEqual(['PLANNING', 'RUNNING', 'SYNTHESIZING', 'SUCCEEDED']);
  });

  it('takes the short way to a failure, because a failed run did not synthesise anything', async () => {
    const admission = await admitRun(store, input('shadow'));
    await settleRun(store, admission, { to: 'DEADLINE_EXCEEDED', code: 'RUN_DEADLINE_EXCEEDED' });

    expect(store.events.map((event) => event.to)).toEqual(['DEADLINE_EXCEEDED']);
  });

  it('writes nothing when the run was never recorded', async () => {
    store.failWith = 'relation "player_insights.runs" does not exist';
    const admission = await admitRun(store, input('shadow'));
    store.failWith = null;
    store.statements.length = 0;

    await settleRun(store, admission, { to: 'FAILED' });

    expect(store.statements).toHaveLength(0);
  });
});

describe('parking a run on somebody else', () => {
  it('leaves it waiting and lets go of it, so the approval is not a duplicate', async () => {
    const admission = await admitRun(store, input('enforce'));
    await parkRun(store, admission, 'plan-fingerprint-1');

    expect(store.runs[0].state).toBe('AWAITING_APPROVAL');
    expect(store.runs[0].lease_expires_at).toBeNull();
    expect(store.runs[0].completed_at).toBeNull();
    expect(store.runs[0].plan_fingerprint).toBe('plan-fingerprint-1');
  });

  it('lets a returning request pick the same run up again rather than being refused', async () => {
    // The case a lease alone gets wrong. A plan shown to somebody already
    // reading it comes back in seconds, well inside the lease window, and a
    // held lease would refuse that as a request already in flight.
    const admission = await admitRun(store, input('enforce', { idempotencyKey: 'client-key-0001' }));
    await parkRun(store, admission, 'plan-fingerprint-1');

    const resumed = await admitRun(
      store,
      input('enforce', { runId: 'run-2', executor: 'container-b', idempotencyKey: 'client-key-0001' })
    );

    expect(resumed.kind).toBe('proceed');
    expect(resumed.kind === 'proceed' && resumed.run?.runId).toBe('run-1');
    expect(store.runs).toHaveLength(1);
  });

  it('does not hold a fresh question back while somebody thinks about a plan', async () => {
    // Deliberate, and the reason AWAITING_APPROVAL is outside EXECUTING_STATES:
    // a parked run is consuming nothing, so it is no evidence that answering
    // the same question again would duplicate any work.
    const admission = await admitRun(store, input('enforce'));
    await parkRun(store, admission, 'plan-fingerprint-1');

    const fresh = await admitRun(store, input('enforce', { runId: 'run-2' }));

    expect(fresh.kind).toBe('proceed');
    expect(fresh.kind === 'proceed' && fresh.run?.runId).toBe('run-2');
  });
});

describe('what the app can say about the release it is running', () => {
  it('reports only what it actually knows', () => {
    // An absent field is better than a fabricated one in an audit trail, and
    // most of what the plan wants here belongs to the release certification
    // workstream and does not exist yet.
    expect(releaseIdentity({} as NodeJS.ProcessEnv)).toEqual({});
    expect(releaseIdentity({ PIA_APP_BUILD_SHA: 'abc123' } as NodeJS.ProcessEnv)).toEqual({ app_build_sha: 'abc123' });
  });

  it('accepts the platform-provided build sha when the bundle does not set one', () => {
    expect(releaseIdentity({ DATABRICKS_APP_BUILD_SHA: 'def456' } as NodeJS.ProcessEnv)).toEqual({
      app_build_sha: 'def456',
    });
  });

  /**
   * A run's cost is never in this database: it lands in `system.billing.usage`
   * hours later, keyed by the resource that did the work. So the run carries the
   * KEYS, and they have to be the same four the Ops cost page queries by, or the
   * join comes out empty and reads as a billing gap.
   */
  it('records the resources a run will be billed under, and where it ran', () => {
    expect(
      releaseIdentity({
        PIA_APP_BUILD_SHA: 'abc123',
        PIA_RELEASE_ID: 'rel-2026-08-17.1',
        DATABRICKS_APP_NAME: 'player-insights-agent',
        DATABRICKS_WORKSPACE_ID: '1234567890',
        PIA_BUNDLE_TARGET: 'example',
        DATABRICKS_SERVING_ENDPOINT_NAME: 'pia-agent',
        DATABRICKS_SQL_WAREHOUSE_ID: 'wh-1',
      } as NodeJS.ProcessEnv)
    ).toEqual({
      app_build_sha: 'abc123',
      release_id: 'rel-2026-08-17.1',
      app_name: 'player-insights-agent',
      workspace_id: '1234567890',
      deployment: 'example',
      serving_endpoint: 'pia-agent',
      warehouse_id: 'wh-1',
    });
  });

  /**
   * `''` in a `warehouse_id` reads as a warehouse whose id is the empty string,
   * and an unset variable in this container arrives as exactly that often enough
   * to matter. Omission is the honest record.
   */
  it('omits a variable that is set to nothing rather than writing it empty', () => {
    expect(
      releaseIdentity({
        DATABRICKS_SQL_WAREHOUSE_ID: '   ',
        DATABRICKS_APP_NAME: '',
        PIA_RELEASE_ID: 'rel-1',
      } as NodeJS.ProcessEnv)
    ).toEqual({ release_id: 'rel-1' });
  });
});
