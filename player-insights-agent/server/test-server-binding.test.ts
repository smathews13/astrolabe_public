import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every test server binds the address its own requests are sent to.
 *
 * Thirteen test files here stand a real HTTP server on an ephemeral port and
 * fetch it over the loopback. `listen(0)` binds the wildcard, 0.0.0.0, and that
 * is not the same thing as the 127.0.0.1 the fetch names: Node sets
 * SO_REUSEADDR, BSD permits a wildcard bind beside a specific one, and so macOS
 * will hand out a port that another process on the machine is already listening
 * on at 127.0.0.1. The listen succeeds. The request is then demuxed to the more
 * specific socket -- the other process -- and the test is answered by a code
 * editor, a music player or a mouse driver.
 *
 * That was a real flake here, not a theoretical one, and it read as several
 * unrelated ones because the symptom is whatever the port's real owner does with
 * an unexpected request: an empty body, ECONNRESET, `other side closed`, a 404
 * from a route that cannot return 404, or a delete that reported success while
 * the fixture it was supposed to empty sat untouched. Measured on this machine
 * across ten workers, the wildcard produced two or three wrong-process answers
 * per four thousand requests and the loopback produced none in eight thousand.
 *
 * It is checked mechanically because the correct version is one argument longer
 * than the habitual one, the wrong version passes locally almost always, and
 * nothing about a green run tells you which you wrote. A new test file gets this
 * for free by failing here once.
 */

const SERVER_DIR = path.resolve(__dirname);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** `listen(0` with whatever follows it, so the host argument can be read. */
const LISTEN = /\.listen\(\s*0\s*(?:,\s*([^,)]+))?/g;

describe('the test servers in this directory', () => {
  it('bind the loopback address rather than the wildcard', () => {
    const wildcard: string[] = [];
    for (const file of testFiles(SERVER_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(LISTEN)) {
        const host = match[1]?.trim();
        // A callback rather than a host is the wildcard spelled differently.
        if (host === "'127.0.0.1'" || host === '"127.0.0.1"') continue;
        wildcard.push(`${path.relative(SERVER_DIR, file)}: ${match[0].trim()}`);
      }
    }
    expect(wildcard).toEqual([]);
  });

  it('are found by this check at all, so an empty pass is not mistaken for a clean one', () => {
    // The guard above passes vacuously if the scan stops finding files or the
    // pattern stops matching, which is the way a check like this dies quietly.
    const listens = testFiles(SERVER_DIR)
      .map((file) => [...readFileSync(file, 'utf8').matchAll(LISTEN)].length)
      .reduce((total, count) => total + count, 0);
    expect(listens).toBeGreaterThanOrEqual(13);
  });
});
