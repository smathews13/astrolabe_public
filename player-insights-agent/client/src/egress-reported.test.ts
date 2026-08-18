/**
 * Keeps `reported` in the registry honest by reading the source, not the claim.
 *
 * `reported` is what makes the panel say "No path reports yet" instead of
 * letting an empty log read as "nothing has left". It is a hand-set boolean, so
 * it can be true about a path nothing calls -- and that failure is invisible,
 * because the symptom is an empty table, which is also what success looks like
 * on a quiet day. The one way to catch it is to go and look for the call.
 *
 * So this reads every client source file, collects the channels passed to
 * `reportEgress`, and requires that set to be exactly the set the registry
 * marks `reported`. Wiring a button without flipping the flag fails here, and so
 * does flipping the flag without wiring the button. The second is the one worth
 * having: it is the direction that turns the panel into a promise.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EGRESS_PATHS, isEgressChannel, type EgressChannel } from '../../shared/egress-contract';

const SOURCE_DIR = join(import.meta.dirname, '.');

/** Every non-test source file under the client, one level of nesting deep. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * The channels something actually reports, read off the calls.
 *
 * Matches a literal channel in a `reportEgress({ channel: '...' })` call and
 * also the `channel` prop passed to a component that forwards one, since a
 * component copying two shapes of thing takes the channel from its caller.
 */
function reportedInSource(): Set<EgressChannel> {
  const channels = new Set<EgressChannel>();
  for (const file of sourceFiles(SOURCE_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('reportEgress')) continue;
    for (const match of text.matchAll(/channel(?:=|:\s*)["']([a-z-]+)["']/g)) {
      const channel = match[1];
      if (isEgressChannel(channel)) channels.add(channel);
    }
  }
  return channels;
}

describe('what the registry says reports', () => {
  it('is exactly what the source calls the recorder for', () => {
    const claimed = EGRESS_PATHS.filter((path) => path.reported).map((path) => path.channel);
    expect([...reportedInSource()].sort()).toEqual([...claimed].sort());
  });

  it('claims nothing for a path the app cannot even observe', () => {
    // A path with no affordance has nothing to hang a recorder on. Marking one
    // `reported` would put a row in the panel that can never arrive.
    for (const path of EGRESS_PATHS) {
      if (path.enforcement === 'uncontrollable') expect(path.reported, path.channel).toBe(false);
    }
  });
});
