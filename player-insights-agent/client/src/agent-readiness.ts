/**
 * Whether the agent endpoint answered, which is the only thing that entitles a
 * screen to say it is ready.
 *
 * The Ask page's status pill said "Ready" from the moment React had mounted. It
 * was a statement about the browser: the bundle had parsed. Nothing behind it had
 * been asked anything, so the pill read exactly the same on a deployment whose
 * endpoint was stopped, whose token had expired, or whose serving principal had
 * lost CAN_QUERY -- and the first a reader learnt of it was the failure of the
 * question they then spent a minute typing.
 *
 * `/api/preflight` is the route that already answers this. It POSTs to the
 * endpoint's own invocations path and adds a check with the id below reporting
 * what happened, so an `ok` here means the app reached the agent and the agent
 * replied, end to end, under the credential the app will use for the question.
 * That is a stronger claim than reading `state.ready` off the serving endpoint's
 * metadata, which says an object exists and nothing about whether this caller may
 * invoke it -- CAN_VIEW and CAN_QUERY are separate grants.
 *
 * WHAT THIS COSTS, AND WHY IT IS STILL ONE REQUEST. That route invokes the
 * endpoint, and `architecture-routes.ts` refuses to do the same on first paint
 * because two invocations on a page somebody opened to read a diagram is a cold
 * start they did not ask for. This page is different in the way that matters: the
 * reader is here to ask the agent something, so the endpoint is going to be woken
 * in the next few seconds anyway, and waking it while they type is better than
 * after they press Ask. The single-flight promise below is what keeps it to one
 * -- `DataEntityLinks` reads the same payload for its tracked-table list, and two
 * modules each memoising their own fetch would be two cold starts, not one.
 *
 * The memo is deliberately never invalidated. It is scoped to the page load, and
 * a reading is of a moment: refreshing it on a timer would produce a pill that
 * flickered between verdicts while somebody was typing, and holding it means the
 * pill can be described honestly as what was true when the screen opened.
 */
import { useEffect, useState } from 'react';

import { isPreflightReport } from './preflight';

/**
 * Four states, because three of them are different kinds of "not ready" and a
 * reader does something different about each. `checking` is in flight, `ready` is
 * the endpoint having answered, `unreachable` is it having failed, and
 * `unchecked` is every way of ending up with no answer at all -- the route
 * unreachable, a body that is not a report, a report with no such check. The last
 * is never drawn as health: a check that did not run is not a check that passed,
 * which is the rule the server applies to its own overall verdict.
 */
export type AgentReadiness = 'checking' | 'ready' | 'unreachable' | 'unchecked';

/** The check `/api/preflight` adds for the endpoint the app itself invokes. */
export const AGENT_ENDPOINT_CHECK = 'agent-endpoint';

export function agentReadinessFrom(payload: unknown): AgentReadiness {
  if (!isPreflightReport(payload)) return 'unchecked';
  const check = payload.checks.find((entry) => entry.id === AGENT_ENDPOINT_CHECK);
  if (!check) return 'unchecked';
  if (check.status === 'ok') return 'ready';
  // 'failed' is the app having tried and been refused or timed out. Everything
  // else the field can hold is 'unverified', which means nobody asked.
  return check.status === 'failed' ? 'unreachable' : 'unchecked';
}

/**
 * The preflight payload, fetched at most once per page load.
 *
 * Resolves rather than rejects, including on a 503: that status is how the route
 * reports an endpoint it could not invoke, and the body is still a report saying
 * so. A caller that treated it as an error would throw away the answer.
 */
let preflightRequest: Promise<unknown> | null = null;

export function readPreflightOnce(): Promise<unknown> {
  preflightRequest ??= fetch('/api/preflight')
    .then((response) => response.json() as Promise<unknown>)
    .catch(() => null);
  return preflightRequest;
}

export function useAgentReadiness(): AgentReadiness {
  // Starts as `checking` rather than as a guess. The pill is drawn from the first
  // paint, and the one thing it may not say in the moment before the route
  // answers is the one thing it used to say from mount: "Ready".
  const [readiness, setReadiness] = useState<AgentReadiness>('checking');
  useEffect(() => {
    let live = true;
    void readPreflightOnce().then((payload) => {
      if (live) setReadiness(agentReadinessFrom(payload));
    });
    return () => {
      live = false;
    };
  }, []);
  return readiness;
}
