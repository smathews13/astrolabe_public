/**
 * The rows of the Sources module: one per table, and what each row's chip says.
 *
 * This replaces `answer-sources.ts`, which grouped the tables under a caption
 * per role. The captions were the only place the distinction was made, so a
 * reader scanning the list of names had to look upwards to find out which of
 * them the numbers came from. The distinction is now on the row, as a chip, and
 * the facts that are true of every row are said once in the module's header.
 *
 * NOTHING HERE INFERS A ROLE, and that is the rule the file exists to hold. A
 * source states one or it does not. The temptation is to look for the name
 * inside the answer's SQL and call it a figure source if it is there, which is
 * exactly the reasoning that once made a dictionary lookup the stated source of
 * an answer's figures: the lookup is a Genie query, so its table is in the SQL
 * too. Where the answer states nothing, the chip says the role was not recorded
 * rather than picking the likelier of the two.
 */

import type { SourceRef, SourceRole } from './answer-shape';

/** Which of the two chip treatments a row takes. */
export type SourceTone = 'queried' | 'neutral';

export interface SourceRow {
  /** The full three-part name, as the answer declared it. */
  name: string;
  /** Everything before the last segment, trailing dot included, or `''`. */
  qualifier: string;
  /** The last segment, which is the part a reader recognises the table by. */
  short: string;
  /** The chip's words. Exactly one chip per row. */
  chip: string;
  tone: SourceTone;
  /**
   * What the chip means, where the label alone does not say it.
   *
   * Carried to the row's tooltip rather than printed beside the chip: the
   * module says a shared fact once in its header and nothing per row except the
   * chip, and a sentence under every second row would undo that.
   */
  note: string;
  /** The freshness the server stated, verbatim, or `''`. */
  freshness: string;
}

/**
 * The chip vocabulary. One entry per role the wire can state, plus the case
 * where it states none.
 *
 * "Definition validation" and "Queried for the figures" are the design's words.
 * The third is not in the design, because the design assumes every source
 * arrives with a role and the wire does not: `role` is optional and absent on
 * every answer stored before the agent began publishing one. A row for such a
 * table has to say something, and the two available labels are both claims
 * about where the numbers came from.
 */
const CHIPS: Record<SourceRole | 'unstated', { chip: string; tone: SourceTone; note: string }> = {
  reading: {
    chip: 'Queried for the figures',
    tone: 'queried',
    note: 'The data in this table is in the numbers shown.',
  },
  reference: {
    chip: 'Definition validation',
    tone: 'neutral',
    note: 'Read for metadata or definitions. Its data is not in the numbers shown.',
  },
  unstated: {
    chip: 'Role not recorded',
    tone: 'neutral',
    note: 'This answer does not record whether the figures came from this table.',
  },
};

/** The last segment of a name, and everything in front of it. */
export function splitSourceName(name: string): { qualifier: string; short: string } {
  const trimmed = name.trim();
  const cut = trimmed.lastIndexOf('.');
  if (cut < 0) return { qualifier: '', short: trimmed };
  return { qualifier: trimmed.slice(0, cut + 1), short: trimmed.slice(cut + 1) };
}

/**
 * Whichever of two roles is the stronger claim about the figures.
 *
 * A run that both queried a table and read its definitions gets the queried
 * chip, per the design: the reader's question is which tables the numbers came
 * from, and "also read for definitions" does not change the answer to it.
 */
function strongerRole(left: SourceRole | 'unstated', right: SourceRole | 'unstated'): SourceRole | 'unstated' {
  if (left === 'reading' || right === 'reading') return 'reading';
  if (left === 'reference' || right === 'reference') return 'reference';
  return 'unstated';
}

/**
 * Every table the answer declared, once each, in the order the run read them.
 *
 * A TABLE APPEARS EXACTLY ONCE. The wire can carry the same name twice -- a
 * table read for a definition and then queried arrives as two entries -- and
 * the strip this replaces drew both, in two different groups, so one table was
 * two rows making two different claims. The entries are collapsed onto the
 * first position the name appeared at, and the surviving row carries the
 * stronger role.
 *
 * Names are matched case-insensitively, because Unity Catalog identifiers are,
 * but the spelling kept is the one the answer used: this list is what a reader
 * compares against the name in the prose above it.
 */
export function sourceRows(sources: readonly SourceRef[]): SourceRow[] {
  const order: string[] = [];
  const seen = new Map<string, { source: SourceRef; role: SourceRole | 'unstated' }>();
  for (const source of sources) {
    const name = source.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const role = source.role ?? 'unstated';
    const previous = seen.get(key);
    if (!previous) {
      order.push(key);
      seen.set(key, { source: { ...source, name }, role });
      continue;
    }
    previous.role = strongerRole(previous.role, role);
    // The freshness of whichever entry stated one, since a second entry for the
    // same table is the same table and the server had one thing to say about it.
    if (!previous.source.freshness && source.freshness) previous.source.freshness = source.freshness;
  }
  return order.map((key) => {
    const { source, role } = seen.get(key)!;
    return {
      name: source.name,
      ...splitSourceName(source.name),
      ...CHIPS[role],
      freshness: source.freshness ?? '',
    };
  });
}

/**
 * How many tables the answer read. The whole of the header's second line.
 *
 * IT USED TO CARRY THE GOVERNANCE CLAIM AND NO LONGER DOES. The string was
 * "N tables · governed Unity Catalog · read during this run", which was the
 * strip's per-row line moved into the header -- an improvement on printing it
 * ten times, and still two sentences the module does not have to say. The
 * Unity Catalog mark beside the word Sources says which product these are, and
 * the module appearing under an answer says the run read them; spelling both
 * out is the app explaining its own design, which section 7 rules out. The
 * detail spec is explicit about it: "No governance line anywhere in the
 * module."
 *
 * Empty for an answer that declared no sources, which is what makes the header
 * read "Sources" with no count rather than "0 tables": a module rendered for
 * its caveats alone is not making a claim about zero tables, it is making no
 * claim about tables at all. Section 7's zero-counts rule, in the one place on
 * this surface where a zero could be printed.
 */
export function sourceFacts(rows: readonly SourceRow[]): string {
  if (rows.length === 0) return '';
  return `${rows.length} ${rows.length === 1 ? 'table' : 'tables'}`;
}
