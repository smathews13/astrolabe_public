/**
 * That a backgrounded tab stops asking, and that coming back asks at once.
 *
 * THIS IS THE ONE CLAIM IN THE STORAGE POLL THAT FAILS SILENTLY. Nothing breaks
 * when a paused poll quietly keeps running: no page is wrong, no number is
 * stale, no test goes red. The tab just spends somebody's battery and fills the
 * app log with reads nobody is looking at, which is a defect discovered by
 * reading a bill rather than by using the app.
 *
 * Driven through a fake host rather than a real tab because this repository has
 * no jsdom -- there is no `document` to hide and no effect that runs. The fake is
 * also the sharper instrument: it can fire two visibility events in a row, which
 * real browsers do and which is the case that leaves a duplicate interval
 * running.
 */
import { describe, expect, it } from 'vitest';

import { pollWhileVisible, type PollHost } from './visibility-polling';

/**
 * A tab whose visibility and clock the test owns.
 *
 * `intervals` counts handles ever started, `live` holds the ones not yet
 * stopped, so a test can tell "started once and stopped" from "started twice".
 */
function fakeTab(startHidden = false) {
  let hidden = startHidden;
  const watchers = new Set<() => void>();
  const live = new Map<number, () => void>();
  let started = 0;
  let reads = 0;

  const host: PollHost = {
    hidden: () => hidden,
    watch: (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    start: (run) => {
      started += 1;
      live.set(started, run);
      return started;
    },
    stop: (handle) => void live.delete(handle),
  };

  return {
    host,
    /** Reads issued so far. */
    reads: () => reads,
    /** Intervals still running. */
    running: () => live.size,
    /** Intervals ever started, including stopped ones. */
    started: () => started,
    read: () => void (reads += 1),
    /** One tick of every running interval. */
    tick: () => {
      for (const run of [...live.values()]) run();
    },
    hide: () => {
      hidden = true;
      for (const notify of [...watchers]) notify();
    },
    show: () => {
      hidden = false;
      for (const notify of [...watchers]) notify();
    },
    /** A visibility event with no change of state, which browsers do fire. */
    repeatEvent: () => {
      for (const notify of [...watchers]) notify();
    },
    watchers: () => watchers.size,
  };
}

describe('a hidden tab does not poll', () => {
  it('stops the interval when the tab is backgrounded', () => {
    const tab = fakeTab();
    pollWhileVisible(tab.read, 20_000, tab.host);
    expect(tab.running(), 'polling while visible').toBe(1);

    tab.hide();
    expect(tab.running(), 'no interval left running once hidden').toBe(0);

    // The claim in its strongest form: time passing in a hidden tab produces
    // no reads at all, rather than fewer of them.
    const before = tab.reads();
    tab.tick();
    tab.tick();
    tab.tick();
    expect(tab.reads()).toBe(before);
  });

  it('never starts one for a tab that opened in the background', () => {
    // A tab opened with cmd-click has nobody to show an answer to, and the read
    // it would make is superseded by the one it makes when somebody looks.
    const tab = fakeTab(true);
    pollWhileVisible(tab.read, 20_000, tab.host);
    expect(tab.started()).toBe(0);
    expect(tab.reads()).toBe(0);
  });

  it('keeps polling on a visible tab, which is the behaviour being preserved', () => {
    const tab = fakeTab();
    pollWhileVisible(tab.read, 20_000, tab.host);
    // One read on arrival, as before visibility was consulted at all.
    expect(tab.reads()).toBe(1);
    tab.tick();
    tab.tick();
    expect(tab.reads()).toBe(3);
  });
});

describe('coming back is not a wait', () => {
  it('reads immediately on becoming visible, then resumes the interval', () => {
    const tab = fakeTab();
    pollWhileVisible(tab.read, 20_000, tab.host);
    tab.hide();
    const whileHidden = tab.reads();

    tab.show();
    // Immediately, not up to 20 seconds later. Returning to a tab is exactly
    // when a reader is most likely to be looking at numbers that have moved.
    expect(tab.reads(), 'a read on the way back').toBe(whileHidden + 1);
    expect(tab.running(), 'and the interval again').toBe(1);

    tab.tick();
    expect(tab.reads()).toBe(whileHidden + 2);
  });

  it('leaves one interval running when the browser fires the event twice', () => {
    // A duplicate visibilitychange on an already-visible tab must not add a
    // second interval: two timers against one stop function is a poll that has
    // silently doubled its rate and can never come back down.
    const tab = fakeTab();
    pollWhileVisible(tab.read, 20_000, tab.host);
    tab.repeatEvent();
    tab.repeatEvent();
    expect(tab.running()).toBe(1);
    expect(tab.started()).toBe(1);

    const before = tab.reads();
    tab.tick();
    expect(tab.reads(), 'one read per tick, not two').toBe(before + 1);
  });
});

describe('teardown leaves nothing behind', () => {
  it('stops the interval and unsubscribes, so nothing can restart it', () => {
    const tab = fakeTab();
    const stop = pollWhileVisible(tab.read, 20_000, tab.host);
    stop();
    expect(tab.running()).toBe(0);
    expect(tab.watchers(), 'no listener on an unmounted component').toBe(0);

    // The half that is easy to leave out: a listener left behind would restart
    // a timer nothing is left to clear.
    const before = tab.reads();
    tab.hide();
    tab.show();
    expect(tab.running()).toBe(0);
    expect(tab.reads()).toBe(before);
  });
});
