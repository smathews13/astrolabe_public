/**
 * The words and the states the egress panel draws, decided here rather than in
 * the markup.
 *
 * ── WHY THE WORDING IS A MODULE AND NOT JSX ──
 *
 * Every string in this capability is a claim about what the app can do, and two
 * of them are claims somebody will act on. "Enforced" beside a switch says the
 * switch bites. "Not classified" beside a table says the catalog is silent, and
 * it must never soften into anything a reader could hear as "no personal data
 * here". Those are the assertions worth a test, and a string interpolated into a
 * component is not one anybody can assert against without rendering a tree.
 *
 * So the panel is markup and this file is what it says. `egress-panel.test.ts`
 * pins the vocabulary, including the words that must NOT appear.
 */

import {
  anythingReports,
  CLASSIFICATION_LABEL,
  CLASSIFICATION_TONE,
  egressPath,
  type EgressEnforcement,
  type EgressEvent,
  type EgressPath,
  type EgressReadState,
  type TableClassification,
} from '../../shared/egress-contract';

/** The pill families the panel draws in, matching the astrolabe recipe names. */
export type PillTone = 'pos' | 'neg' | 'warn' | 'neutral' | 'info';

export interface Pill {
  label: string;
  tone: PillTone;
}

/**
 * What the app can do about a path, in two words beside its switch.
 *
 * ── "RECORDED ONLY" IS THE HONEST WORD AND IT COST AN ARGUMENT ──
 *
 * The tempting label for a `stored` path is nothing at all: draw the switch, let
 * the reader assume. That is the failure this whole field exists against. An
 * administrator turning off "Step input and output copy" and seeing no
 * qualification will believe the copy button is gone, will say so to somebody,
 * and the button will still be there. "Recorded only" is unglamorous and it is
 * what is true: the preference is saved and the export is logged when it happens,
 * and nothing removes the affordance yet.
 *
 * The tone is deliberately NOT positive for either. A green chip on a control is
 * this panel congratulating itself.
 */
export const ENFORCEMENT_PILL: Readonly<Record<EgressEnforcement, Pill>> = {
  enforced: { label: 'Enforced', tone: 'info' },
  stored: { label: 'Recorded only', tone: 'warn' },
  uncontrollable: { label: 'Cannot be stopped', tone: 'neutral' },
};

/**
 * Where the enforcement happens, for the paths where it does.
 *
 * Two kinds, and the difference is worth a reader's attention: one withholds the
 * value so it never reaches the browser, the other removes a control in a browser
 * that already has the value. Empty for a path that enforces nothing, so the row
 * prints nothing rather than a hedge.
 */
export const ENFORCEMENT_SITE: Readonly<Partial<Record<string, string>>> = {
  'workspace-link': 'Withheld by the server',
  'chart-image': 'Control removed in the browser',
};

export function enforcementPill(path: EgressPath): Pill {
  return ENFORCEMENT_PILL[path.enforcement];
}

/** Where the affordance is, and how far the switch reaches. No sentence, no prose. */
export function pathMeta(path: EgressPath): string[] {
  const facts = [path.where];
  const site = ENFORCEMENT_SITE[path.channel] ?? '';
  if (site) facts.push(site);
  const reporting = reportingNote(path);
  if (reporting) facts.push(reporting);
  return facts;
}

/* ── The log ───────────────────────────────────────────────────────────────── */

/**
 * Whether an export was permitted, in one word.
 *
 * `refused` is the interesting row and reads as negative on purpose. It is a
 * client that reported an export through a path this deployment has turned off:
 * an old bundle, a tab open since before the switch moved, or somebody who put
 * the affordance back. An administrator scanning the log should find it.
 */
export const OUTCOME_PILL: Readonly<Record<EgressEvent['outcome'], Pill>> = {
  left: { label: 'Left', tone: 'neutral' },
  refused: { label: 'Refused', tone: 'neg' },
};

/**
 * The facts beside one row, in reading order, ready to be joined by ' · '.
 *
 * ── ZERO NEVER RENDERS, AND NEITHER DOES NULL ──
 *
 * `itemCount` is null for "not counted" and the app's rule is that a zero count
 * is not printed. Both are dropped here rather than at the markup, so the two
 * cannot disagree. An export of nothing is not an export, so a zero arriving is a
 * bug upstream and printing "0 items" would put that bug on an administrator's
 * screen dressed as a fact.
 */
export function eventFacts(event: EgressEvent): string[] {
  const facts: string[] = [];
  const path = egressPath(event.channel);
  facts.push(path?.label ?? event.channel);
  if (event.surface) facts.push(event.surface);
  if (typeof event.itemCount === 'number' && event.itemCount > 0) {
    facts.push(`${event.itemCount} item${event.itemCount === 1 ? '' : 's'}`);
  }
  return facts;
}

/** Whether the row can offer a way through to what it points at. */
export function eventPointer(event: EgressEvent): { runId: string } | null {
  return event.runId ? { runId: event.runId } : null;
}

/**
 * What the panel says when the log has no rows, which is three different things.
 *
 * "Nothing has left" and "the record could not be read" put the same zero rows on
 * screen and mean opposite things, and the third -- the table is not there yet --
 * is a deployment that has not run the migration rather than a fault. Each gets
 * its own words, because an administrator acting on the wrong one either relaxes
 * about a blind spot or chases an outage that is not happening.
 */
export const READ_STATE_NOTE: Readonly<Record<EgressReadState, string>> = {
  read: 'Nothing recorded yet',
  unavailable: 'The record could not be read',
  'not-migrated': 'The record has not been created on this deployment',
};

/**
 * The fourth state, and the one that would otherwise be a lie.
 *
 * ── AN EMPTY LOG ONLY MEANS "NOTHING LEFT" IF SOMETHING WOULD HAVE SAID SO ──
 *
 * Every affordance that reports an export does so from the browser it happened
 * in, and until a surface calls the recorder, this table stays empty however
 * much leaves. "Nothing recorded yet" on that deployment is technically accurate
 * and reads as "nothing has left", which is the most comfortable possible wrong
 * answer for an administrator to take away from a page about data leaving.
 *
 * So where no path reports, the card says that instead of printing a zero. It
 * disappears on its own as producers land, because {@link anythingReports} is
 * derived from the registry rather than written here.
 */
export const NOTHING_REPORTS_NOTE = 'No path reports yet';

/**
 * What an empty log says, checked in the order that a reader needs.
 *
 * The read failures come FIRST. A deployment where nothing reports and the store
 * is also down should say the store is down, because that is the fault and the
 * other is a known gap.
 */
export function emptyLogNote(readState: EgressReadState, reports: boolean = anythingReports()): string {
  if (readState !== 'read') return READ_STATE_NOTE[readState];
  return reports ? READ_STATE_NOTE.read : NOTHING_REPORTS_NOTE;
}

/**
 * A read that could not happen is a warning, not a quiet empty state.
 *
 * And so is a deployment where nothing reports, for the same reason: both are
 * blind spots wearing an empty list, and neutral would let a reader scroll past.
 */
export function readStateTone(readState: EgressReadState, reports: boolean = anythingReports()): PillTone {
  if (readState !== 'read') return 'warn';
  return reports ? 'neutral' : 'warn';
}

/**
 * Whether one path would be recorded if it were used, beside its switch.
 *
 * Only rendered when it is FALSE, and only on a path that has a switch. A row
 * saying "Recorded only" whose channel reports nothing is the panel's worst
 * sentence, because the label is the whole of what the switch does and it is not
 * happening either.
 */
export function reportingNote(path: EgressPath): string {
  if (path.enforcement === 'uncontrollable' || path.reported) return '';
  return 'Not recorded yet';
}

/* ── What the catalog says ─────────────────────────────────────────────────── */

/**
 * The pill for one table, straight from the shared contract.
 *
 * Re-exported through here rather than imported by the component so that every
 * word this capability puts on screen comes from one module and one test.
 */
export function classificationPill(table: TableClassification): Pill {
  return {
    label: CLASSIFICATION_LABEL[table.state],
    tone: CLASSIFICATION_TONE[table.state],
  };
}

/**
 * What the catalog carries on a table, counted, never quoted.
 *
 * ── THE THREE STATES SAY DIFFERENT THINGS AND NONE OF THEM IS A CLEARANCE ──
 *
 *   classified      Unity Catalog holds tags, a mask or a row filter here. What
 *                   those tags MEAN is the customer's taxonomy and this app does
 *                   not interpret it. So the panel counts them and stops.
 *   not-classified  The catalog is silent about this table. That is a fact about
 *                   its governance and NOT a finding about its contents.
 *   not-checked     This request could not ask. A fact about the request.
 *
 * Tag NAMES are counted rather than listed here because a tag name can itself be
 * a customer's own vocabulary; the component lists them under the count, where
 * the administrator has already chosen to look at one table.
 */
export function classificationFacts(table: TableClassification): string[] {
  if (table.state === 'not-checked') return table.notChecked ? [table.notChecked] : [];
  const facts: string[] = [];
  const tagged = table.columns.filter((column) => column.tags.length > 0).length;
  const masked = table.columns.filter((column) => column.masked).length;
  if (tagged > 0) facts.push(`${tagged} tagged column${tagged === 1 ? '' : 's'}`);
  if (masked > 0) facts.push(`${masked} masked column${masked === 1 ? '' : 's'}`);
  if (table.rowFilter === true) facts.push('Row filter');
  return facts;
}

/**
 * The words under the classification list, which are the ones Sam reads aloud.
 *
 * ── EVERY CLAUSE HERE IS A LIMIT, AND THAT IS THE DESIGN ──
 *
 * This is the only place in the capability that describes what the classification
 * IS, and it exists because the alternative was an administrator inferring it. It
 * says where the answer comes from, whose permissions it ran under, and -- the
 * part that matters -- that silence is silence. It does not say the app inspected
 * anything, because it did not: there is no value sampling in this capability and
 * there is not going to be. A detector that guesses would be both wrong and
 * believed.
 *
 * Short enough not to be prose on a page. It is a caption on a list of states,
 * which is the one place the design's no-explanations rule has to give, because
 * the alternative is three state words a reader has to guess the meaning of.
 */
export const CLASSIFICATION_CAPTION =
  'From Unity Catalog tags, masks and row filters, read as you. No column values are inspected.';

/** Why nothing could be read at all, or '' when the reads ran. */
export function classificationBlockedNote(blocked: string): string {
  return blocked;
}

/* ── The switch an administrator is actually moving ────────────────────────── */

/**
 * The accessible name on one control.
 *
 * Names the ACTION and not the path, so the switch and the label above it are
 * different strings to a screen reader and to a by-name locator, which is the
 * pattern the settings page already follows.
 */
export function controlAccessibleName(path: EgressPath): string {
  return `Permit ${path.label.toLowerCase()}`;
}

/**
 * What a failed write says. Never silent, and never optimistic.
 *
 * A switch that springs back with no explanation reads as a broken control. A
 * switch that stays where it was put and did not save is worse: the administrator
 * leaves believing the deployment is configured.
 */
export const CONTROL_WRITE_FAILED = 'Not saved';
