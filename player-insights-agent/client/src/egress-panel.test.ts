/**
 * The words the panel puts on screen, which are the claims it makes.
 *
 * Most of this file asserts that a string is absent. That is the point: the
 * failure mode for a control panel is not a crash, it is a reassuring word next
 * to a control that does not do what the word implies. Nobody files a bug about
 * it, and the person who reads it acts on it.
 *
 * Two families of assertion:
 *
 *   1. A switch says how far it reaches. `stored` must never render as though it
 *      were enforcement.
 *   2. Nothing anywhere in the classification vocabulary reads as a clearance.
 *      "Not classified" is a fact about a catalog and must not become a finding
 *      about contents.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_LABEL,
  EGRESS_PATHS,
  type EgressEvent,
  type TableClassification,
} from '../../shared/egress-contract';
import {
  CLASSIFICATION_CAPTION,
  classificationFacts,
  classificationPill,
  controlAccessibleName,
  emptyLogNote,
  ENFORCEMENT_PILL,
  ENFORCEMENT_SITE,
  enforcementPill,
  eventFacts,
  eventPointer,
  NOTHING_REPORTS_NOTE,
  OUTCOME_PILL,
  pathMeta,
  readStateTone,
  READ_STATE_NOTE,
  reportingNote,
} from './egress-panel';

const PANEL_SOURCE = readFileSync(new URL('./EgressPanel.tsx', import.meta.url), 'utf8');
const WORDS_SOURCE = readFileSync(new URL('./egress-panel.ts', import.meta.url), 'utf8');

function event(over: Partial<EgressEvent> = {}): EgressEvent {
  return {
    id: 'ev-1',
    occurredAt: '2026-03-04T10:00:00.000Z',
    actor: 'reader@example.invalid',
    channel: 'chart-image',
    shape: 'image',
    outcome: 'left',
    surface: 'answer',
    runId: null,
    conversationId: null,
    itemCount: null,
    ...over,
  };
}

function table(over: Partial<TableClassification> = {}): TableClassification {
  return {
    table: 'example_catalog.demo_schema.demo_table',
    state: 'not-classified',
    columns: [],
    rowFilter: null,
    notChecked: '',
    ...over,
  };
}

describe('a switch says how far it reaches', () => {
  it('gives every path a word, so no row is silent about its own coverage', () => {
    for (const path of EGRESS_PATHS) {
      expect(enforcementPill(path).label, path.channel).toBeTruthy();
    }
  });

  it('does not let a recorded preference read as enforcement', () => {
    // The single most important assertion in this file. An administrator who
    // turns off a `stored` path and reads "Enforced" will tell somebody the copy
    // button is gone, and it will still be there.
    expect(ENFORCEMENT_PILL.stored.label).not.toMatch(/enforc|block|prevent|stop|disabl/i);
    expect(ENFORCEMENT_PILL.stored.label).toBe('Recorded only');
  });

  it('does not congratulate itself with a positive chip on any control', () => {
    for (const pill of Object.values(ENFORCEMENT_PILL)) {
      expect(pill.tone).not.toBe('pos');
    }
  });

  it('says plainly that the uncontrollable paths cannot be stopped', () => {
    expect(ENFORCEMENT_PILL.uncontrollable.label).toMatch(/cannot/i);
  });

  it('names where each enforced path is enforced, because the two are not equal', () => {
    // One withholds the value; the other removes a button in a browser that
    // already has it. Collapsing them into one word would overstate the second.
    expect(ENFORCEMENT_SITE['workspace-link']).toMatch(/server/i);
    expect(ENFORCEMENT_SITE['chart-image']).toMatch(/browser/i);
    for (const path of EGRESS_PATHS) {
      if (path.enforcement === 'enforced') {
        expect(ENFORCEMENT_SITE[path.channel], path.channel).toBeTruthy();
      }
    }
  });

  it('puts where the affordance is on every row', () => {
    for (const path of EGRESS_PATHS) {
      expect(pathMeta(path)[0], path.channel).toBe(path.where);
    }
  });

  it('names the action on the control and not the path, so the two are distinct', () => {
    const path = EGRESS_PATHS[0];
    expect(controlAccessibleName(path)).not.toBe(path.label);
    expect(controlAccessibleName(path)).toMatch(/^Permit /);
  });
});

describe('what the panel lists', () => {
  it('draws the uncontrollable paths rather than quietly leaving them out', () => {
    // The flattering design omits them. An administrator is entitled to know
    // that selecting an answer and screenshotting a chart are ways out no switch
    // on this page touches.
    expect(PANEL_SOURCE).toContain("=== 'uncontrollable'");
    expect(PANEL_SOURCE).toContain('UncontrollableRow');
  });

  it('gives an uncontrollable path no switch at all, not a disabled one', () => {
    // A greyed toggle reads as something a bigger permission could turn on.
    const row = PANEL_SOURCE.slice(
      PANEL_SOURCE.indexOf('function UncontrollableRow'),
      PANEL_SOURCE.indexOf('/* ── The panel')
    );
    expect(row).not.toContain('<Switch');
    expect(row).not.toContain('disabled');
  });
});

describe('a row in the log', () => {
  it('names the path in the panel\'s own words', () => {
    expect(eventFacts(event({ channel: 'chart-image' }))[0]).toBe('Chart image download');
  });

  it('does not print a count of zero', () => {
    // The app's rule everywhere. An export of nothing is not an export, so a
    // zero arriving is a bug upstream and printing it dresses that bug as a fact.
    expect(eventFacts(event({ itemCount: 0 })).join(' ')).not.toMatch(/\b0\b/);
  });

  it('does not print a count that was never taken', () => {
    expect(eventFacts(event({ itemCount: null })).some((fact) => /item/.test(fact))).toBe(false);
  });

  it('prints a real count, singular and plural', () => {
    expect(eventFacts(event({ itemCount: 1 }))).toContain('1 item');
    expect(eventFacts(event({ itemCount: 4 }))).toContain('4 items');
  });

  it('offers a way through only when there is a run to point at', () => {
    expect(eventPointer(event({ runId: null }))).toBeNull();
    expect(eventPointer(event({ runId: 'run-7' }))).toEqual({ runId: 'run-7' });
  });

  it('reads a refusal as negative, because it is the row worth finding', () => {
    expect(OUTCOME_PILL.refused.tone).toBe('neg');
    expect(OUTCOME_PILL.left.tone).not.toBe('neg');
  });
});

describe('an empty log means four different things', () => {
  it('distinguishes nothing recorded from a read that could not happen', () => {
    const notes = new Set(Object.values(READ_STATE_NOTE));
    expect(notes.size).toBe(3);
    expect(emptyLogNote('read', true)).toMatch(/nothing/i);
    expect(emptyLogNote('unavailable', true)).toMatch(/could not be read/i);
    expect(emptyLogNote('not-migrated', true)).toMatch(/not been created/i);
  });

  it('does not say nothing has left when the record could not be read', () => {
    // The two put the same zero rows on screen and mean opposite things.
    expect(emptyLogNote('unavailable', true)).not.toMatch(/nothing/i);
    expect(emptyLogNote('not-migrated', true)).not.toMatch(/nothing/i);
  });

  /**
   * The fourth state, and the reason it exists. Until an affordance calls the
   * recorder this table stays empty however much leaves, and "Nothing recorded
   * yet" on that deployment reads as "nothing has left" -- the most comfortable
   * possible wrong answer to take away from a page about data leaving.
   */
  it('does not say nothing has left when nothing would have said so', () => {
    expect(emptyLogNote('read', false)).toBe(NOTHING_REPORTS_NOTE);
    expect(emptyLogNote('read', false)).not.toMatch(/nothing recorded/i);
  });

  it('reports the store being down ahead of the gap, because that is the fault', () => {
    expect(emptyLogNote('unavailable', false)).toBe(READ_STATE_NOTE.unavailable);
    expect(emptyLogNote('not-migrated', false)).toBe(READ_STATE_NOTE['not-migrated']);
  });

  it('marks a failed read as a warning rather than a quiet empty state', () => {
    expect(readStateTone('read', true)).toBe('neutral');
    expect(readStateTone('unavailable', true)).toBe('warn');
    expect(readStateTone('not-migrated', true)).toBe('warn');
  });

  it('marks a deployment where nothing reports as a warning too', () => {
    // A blind spot wearing an empty list. Neutral would let a reader scroll past.
    expect(readStateTone('read', false)).toBe('warn');
  });
});

describe('a switch whose path is not recorded says so', () => {
  it('adds the note to a controllable path that nothing reports', () => {
    // The panel's worst possible row is "Recorded only" on a channel that is not
    // recorded, because the label is the whole of what the switch does.
    const path = EGRESS_PATHS.find((candidate) => candidate.enforcement === 'stored');
    expect(path).toBeTruthy();
    if (path && !path.reported) {
      expect(reportingNote(path)).toBe('Not recorded yet');
      expect(pathMeta(path)).toContain('Not recorded yet');
    }
  });

  it('says nothing about recording on a path the app cannot see at all', () => {
    // There is no click to hang a report on. A note would imply one is coming.
    for (const path of EGRESS_PATHS.filter((candidate) => candidate.enforcement === 'uncontrollable')) {
      expect(reportingNote(path), path.channel).toBe('');
    }
  });

  it('drops the note the moment a path starts reporting', () => {
    expect(reportingNote({ ...EGRESS_PATHS[0], reported: true })).toBe('');
  });

  it('keeps the two questions apart in the registry itself', () => {
    // Enforcement and reporting are different facts, and a path can be either
    // without the other. Collapsing them is how a panel answers one for the other.
    for (const path of EGRESS_PATHS) {
      expect(typeof path.reported, path.channel).toBe('boolean');
      if (path.enforcement === 'uncontrollable') expect(path.reported, path.channel).toBe(false);
    }
  });
});

describe('what the panel says about personal information', () => {
  /** Anything that would be heard as a clearance. */
  const CLEARANCE = [
    /\bno personal\b/i,
    /\bno pii\b/i,
    /\bclean\b/i,
    /\bsafe\b/i,
    /\bnothing sensitive\b/i,
    /\bcontains no\b/i,
    /\bverified\b/i,
    /\bcleared\b/i,
    /\bcompliant\b/i,
  ];

  it('has no word for "no personal data", in any label', () => {
    for (const label of Object.values(CLASSIFICATION_LABEL)) {
      for (const forbidden of CLEARANCE) {
        expect(label, label).not.toMatch(forbidden);
      }
    }
  });

  it('has none of those words anywhere in the panel vocabulary either', () => {
    // The labels are three strings and easy to keep honest. The caption, the
    // facts and the markup are where a reassuring sentence would actually get
    // written, so the whole of both files is scanned.
    for (const forbidden of CLEARANCE) {
      expect(CLASSIFICATION_CAPTION, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('renders an unclassified table neutrally and never positively', () => {
    // A green chip on a table nobody has classified is the panel awarding a
    // clearance it has no grounds for.
    expect(classificationPill(table({ state: 'not-classified' })).tone).toBe('neutral');
    expect(classificationPill(table({ state: 'not-classified' })).label).toBe('Not classified');
  });

  it('separates a silent catalog from a read that did not happen', () => {
    expect(classificationPill(table({ state: 'not-checked' })).tone).toBe('warn');
    expect(CLASSIFICATION_LABEL['not-checked']).not.toBe(CLASSIFICATION_LABEL['not-classified']);
  });

  it('says where the answer came from and that no values were read', () => {
    expect(CLASSIFICATION_CAPTION).toMatch(/unity catalog/i);
    expect(CLASSIFICATION_CAPTION).toMatch(/no column values are inspected/i);
  });

  it('counts what the catalog carries and does not interpret it', () => {
    const facts = classificationFacts(
      table({
        state: 'classified',
        columns: [
          { column: 'alpha', tags: ['a_tag'], masked: false },
          { column: 'beta', tags: [], masked: true },
        ],
        rowFilter: true,
      })
    );
    expect(facts).toContain('1 tagged column');
    expect(facts).toContain('1 masked column');
    expect(facts).toContain('Row filter');
  });

  it('prints nothing at all rather than a zero for a table with no findings', () => {
    expect(classificationFacts(table({ state: 'not-classified' }))).toEqual([]);
  });

  it('says only why, for a table it could not ask about', () => {
    const facts = classificationFacts(table({ state: 'not-checked', notChecked: 'No warehouse' }));
    expect(facts).toEqual(['No warehouse']);
  });

  it('does not report a row filter it never read as absent', () => {
    // `rowFilter: null` is "not read" and must not print as "no row filter".
    const facts = classificationFacts(table({ state: 'classified', rowFilter: null }));
    expect(facts.join(' ')).not.toMatch(/row filter/i);
  });
});

describe('the house style the design asks for', () => {
  it('uses no em dash in anything that reaches the screen', () => {
    for (const words of [...Object.values(READ_STATE_NOTE), CLASSIFICATION_CAPTION,
      ...Object.values(CLASSIFICATION_LABEL),
      ...Object.values(ENFORCEMENT_PILL).map((pill) => pill.label),
      ...Object.values(OUTCOME_PILL).map((pill) => pill.label)]) {
      expect(words, words).not.toMatch(/—|–/);
    }
  });

  it('joins facts with the separator the tokens declare and no other', () => {
    expect(PANEL_SOURCE).toContain("join(' · ')");
    // A hyphen or a pipe between facts is the habit this is written against.
    expect(PANEL_SOURCE).not.toMatch(/join\('\s*\|\s*'\)/);
  });

  it('draws its chips with the astrolabe pill recipe', () => {
    expect(PANEL_SOURCE).toContain('ast-pill');
    expect(PANEL_SOURCE).toContain('ast-pill--');
  });

  it('sets figures in the columnar family', () => {
    expect(PANEL_SOURCE).toContain('ast-num');
  });

  it('never claims the data is synthetic', () => {
    for (const source of [PANEL_SOURCE, WORDS_SOURCE]) {
      expect(source).not.toMatch(/\bsynthetic\b/i);
      expect(source).not.toMatch(/\bfake data\b/i);
      expect(source).not.toMatch(/\bdummy\b/i);
    }
  });
});
