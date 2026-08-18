/**
 * What this deployment permits leaving by, as the browser knows it, and the way
 * a component says an export happened.
 *
 * ── WHY THIS IS A SNAPSHOT AND NOT A HOOK ──
 *
 * The first caller is Plotly's config object. Plotly reads its context
 * synchronously while drawing and there is no React around that read, so a hook
 * cannot reach it. A module-level snapshot can, and it is the same value every
 * other caller sees, which is what stops two surfaces reaching different
 * conclusions about the same switch.
 *
 * ── WHAT THE SNAPSHOT IS BEFORE THE ANSWER ARRIVES ──
 *
 * The build's defaults, which for every path with a switch means the CLOSED
 * state is the one in force while the fetch is out. That direction is chosen and
 * not incidental: a control that is briefly permissive during boot is a control
 * that a fast click defeats, and the paths defaulted off are exactly the ones
 * carrying rows.
 *
 * ── THIS IS AN AFFORDANCE, NOT A PERIMETER ──
 *
 * Everything here runs in the browser, on data the browser already has. Removing
 * a button removes the button. It does not remove the reader's ability to select,
 * screenshot or read the network tab, and nothing in this file should ever be
 * described as though it did. The paths that genuinely cannot leak are the ones
 * where the server does not send the value at all, and there is one of those --
 * see `workspaceLinksAllowed` on the server. The rest are affordances, and
 * `EgressPath.enforcement` in the shared contract is what says which is which.
 */

import {
  defaultEgressControls,
  egressAllowed,
  isEgressChannel,
  type EgressChannel,
  type EgressControls,
  type EgressControlsPayload,
  type EgressReport,
} from '../../shared/egress-contract';

let controls: EgressControls = defaultEgressControls();
let loaded = false;
let inFlight: Promise<void> | null = null;

/** Redrawn on a change, so a switch moved in Settings reaches a chart already on screen. */
const listeners = new Set<() => void>();

function announce() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One subscriber throwing must not strand the others, and there is nothing
      // useful to do about it here.
    }
  }
}

/**
 * Whether one path is permitted, answered from the snapshot, synchronously.
 *
 * Never throws and never waits. A caller drawing a button gets an answer or it
 * gets the build's default, and both are usable; a promise here would mean every
 * copy button in the app had a loading state for a boolean.
 */
export function egressPathAllowed(channel: EgressChannel): boolean {
  return egressAllowed(controls, channel);
}

/** The whole snapshot, for a panel that draws every row at once. */
export function egressControlsSnapshot(): EgressControls {
  return controls;
}

/** Whether the deployment's answer has arrived, so a panel can say which it is showing. */
export function egressPolicyLoaded(): boolean {
  return loaded;
}

/**
 * Fetch what the deployment permits. Safe to call repeatedly and from anywhere.
 *
 * A failure leaves the defaults in place and does NOT mark the policy loaded, so
 * a later caller retries. It deliberately does not fall back to permissive: a
 * deployment whose control endpoint is down is not a deployment that has decided
 * everything may leave.
 */
export function loadEgressPolicy(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch('/api/egress/controls', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const payload = (await response.json()) as Partial<EgressControlsPayload>;
      if (!payload || typeof payload.controls !== 'object' || payload.controls === null) return;
      const next = { ...defaultEgressControls() } as Record<EgressChannel, boolean>;
      for (const [channel, allowed] of Object.entries(payload.controls)) {
        if (isEgressChannel(channel) && typeof allowed === 'boolean') next[channel] = allowed;
      }
      controls = next;
      loaded = true;
      announce();
    } catch {
      // Offline, or the route is not there on an older server. Defaults stand.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Subscribe to changes. Returns the unsubscribe. */
export function onEgressPolicyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The route the click happened on, for a caller that did not name one.
 *
 * The path and nothing else. NOT the query string and NOT the hash: a run id, a
 * conversation id or a search term can sit in either, and this capability's one
 * inviolable rule is that the record says an export happened rather than what
 * was in it. A surface string carrying `?q=<what somebody asked>` would put the
 * question into the audit table by the back door.
 */
function currentSurface(): string {
  try {
    return typeof window === 'undefined' ? '' : window.location.pathname;
  } catch {
    return '';
  }
}

/**
 * Say that something left, or was refused.
 *
 * Fire and forget, and it never throws or returns anything a caller has to
 * handle. An export must not be blocked, delayed or made to look failed because
 * the record of it could not be written -- the button's job is the button's job.
 * The server decides `left` against `refused` and takes the actor from the
 * request, so neither is a parameter here.
 */
export function reportEgress(report: EgressReport): void {
  if (typeof fetch !== 'function') return;
  void fetch('/api/egress/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: report.channel,
      surface: report.surface ?? currentSurface(),
      runId: report.runId ?? null,
      conversationId: report.conversationId ?? null,
      itemCount: report.itemCount ?? null,
    }),
    keepalive: true,
  }).catch(() => {
    // Deliberately silent. See above.
  });
}

/**
 * Apply a set the panel has just been handed by the server, without a re-fetch.
 *
 * The administrator who moved the switch is holding the response that says what
 * moved. Making their own browser fetch it again to find out is a round trip
 * that can disagree with what they are looking at.
 */
export function adoptEgressControls(next: EgressControls): void {
  controls = next;
  loaded = true;
  announce();
}

/** Back to the build's defaults, unloaded. For tests, which share module state. */
export function resetEgressPolicy(): void {
  controls = defaultEgressControls();
  loaded = false;
  inFlight = null;
}

// Kicked off on import rather than from a boot sequence in a file another lane
// owns. The first import is the chart component's, which is evaluated when a
// bundle chunk loads and long before a figure is drawn, so the answer is
// normally in hand by the first paint. Guarded on `window` because this module
// is imported by tests running in node, where a fetch would be a network call
// from a unit suite.
if (typeof window !== 'undefined') void loadEgressPolicy();
