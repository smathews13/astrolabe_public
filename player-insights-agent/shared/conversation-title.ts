/**
 * The label a conversation carries in the rail, derived from its first question.
 *
 * WHY THIS IS SHARED. Two places built this label independently and both wrote
 * `prompt.slice(0, 80)`: the server, when it inserts the conversation row, and the
 * browser, when it puts an optimistic row in the rail before that insert returns.
 * Two copies of one rule is a rail whose label CHANGES on reload if either copy is
 * ever edited alone, and the browser's copy is the one a reader sees first, so the
 * stored label would look like the wrong one.
 *
 * WHY IT IS NOT 80 ANY MORE. A hard 80-character cut is not an abbreviation, it is
 * a deletion: it lands mid-word, it appends nothing to say it landed, and it is
 * what the row stores, so the whole label is gone rather than merely hidden. Real
 * questions here run past it — "Which three titles had the most active players in
 * the last 30 days, and how many" is exactly what 80 characters did to a question
 * that went on to ask "did each have?" — and the rail had no way to show the rest
 * or even to show that there WAS a rest.
 *
 * So the limit is generous and the display does the shortening. The rail clamps to
 * two lines in CSS, which is reversible, and the row keeps enough to be readable in
 * full on hover or in any wider surface later. The cap that remains is only there
 * to stop a pasted page of text becoming a table row.
 */

/**
 * Long enough that a question a person actually types survives intact, short enough
 * that a paste does not. Not a display width: the rail's own clamp decides that.
 */
export const CONVERSATION_TITLE_LIMIT = 300;

/** Appended only when something was actually removed, so it means what it shows. */
const ELLIPSIS = '\u2026';

/**
 * The label a conversation holds before anybody has asked anything in it.
 *
 * A conversation can exist before its first question, because attaching a document
 * creates the row. Shared because it is COMPARED as well as written: the browser
 * drops its own placeholder row by matching this text, and the ask upsert below
 * replaces a title only while it still reads this way. Three copies of a string
 * three pieces of code test each other against is a rail that quietly keeps two
 * "New conversation" rows, or never renames one.
 */
export const PLACEHOLDER_CONVERSATION_TITLE = 'New conversation';

/**
 * Derive a conversation's rail label from the question that started it.
 *
 * Whitespace is collapsed first: a prompt can carry newlines and runs of spaces,
 * and those render as ragged gaps in a two-line clamp rather than as the text
 * somebody typed.
 */
export function conversationTitle(prompt: string, limit = CONVERSATION_TITLE_LIMIT): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;

  // Room for the ellipsis is taken out of the budget rather than added on top, so
  // the result honours `limit` and a caller can size a column by it.
  const room = Math.max(0, limit - ELLIPSIS.length);
  const cut = collapsed.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');

  // A single unbroken token longer than the budget — a pasted URL, a fully
  // qualified table name — has no word boundary to cut on, and cutting at
  // `lastSpace` there would return an empty label. Cut it hard instead.
  const body = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}${ELLIPSIS}`;
}
