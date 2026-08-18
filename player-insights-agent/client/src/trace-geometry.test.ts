import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Which rule wins for the step panel's two nested label grids.
 *
 * This file exists because the whole suite was green while the fact grid shipped
 * visibly broken, and it could not have been otherwise: every assertion anyone
 * had written was about CONTENT, and what was wrong was which of two grid
 * declarations the cascade picked. "Key used" was drawn on top of the table
 * chip, the Count value came out one word per line, and the rows were cut off at
 * the right edge -- three symptoms of one fault that no test about markup or
 * text could see.
 *
 * The fault: the panel's own label grid was written `.dag-detail dl`, a
 * DESCENDANT, so it also claimed the `dl` a rendered result nests inside the
 * Result row's `dd`. Three classes plus a type out-specifies the three classes
 * `.dag-facts` has, so the fact grid's `display: block` lost, its rows became
 * items of a two-track grid -- two facts to a row -- and each pair's own 96px
 * label column was crushed into a 110px cell, leaving about four pixels of value.
 *
 * So the thing to assert is the cascade, and the cascade is computable: parse
 * the stylesheet, match its selectors against the element paths the renderers
 * actually build, and rank by specificity then source order. That is what the
 * browser does to choose a value, and it is the half of the problem that does
 * not need layout. What it cannot tell us is the pixel result of the tracks it
 * picks -- no assertion here proves the value column is legible, only that it is
 * sized by a rule that permits it to be. That last step needs eyes on a screen.
 */

const CSS = readFileSync(new URL('./styles/trace.css', import.meta.url), 'utf8');

/** One element on the path from the root to the element being resolved. */
interface Step {
  type: string;
  classes: string[];
}

function at(type: string, ...classes: string[]): Step {
  return { type, classes };
}

interface Rule {
  selector: string;
  declarations: Map<string, string>;
  specificity: number;
  order: number;
}

/**
 * Rules in source order, comments removed.
 *
 * Deliberately a small parser rather than a dependency: it has to handle the one
 * stylesheet in front of it, and every construct in it is a flat rule.
 */
function rules(css: string): Rule[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const found: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(flat); match; match = pattern.exec(flat)) {
    const declarations = new Map<string, string>();
    for (const line of match[2].split(';')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    for (const selector of match[1].split(',')) {
      const trimmed = selector.trim();
      if (trimmed === '') continue;
      found.push({ selector: trimmed, declarations, specificity: specificity(trimmed), order: found.length });
    }
  }
  return found;
}

/**
 * A selector's weight as one comparable number.
 *
 * Ids, then classes and pseudo-classes and attributes, then types. Base 1000 per
 * level, which no selector here comes close to overflowing, and the ordering is
 * all that is being compared.
 */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g)?.length ?? 0;
  const types = selector.match(/(^|[\s>+~])[a-z][\w-]*/g)?.length ?? 0;
  return ids * 1_000_000 + classes * 1000 + types;
}

/** Whether one compound selector describes one element. */
function compoundMatches(compound: string, step: Step): boolean {
  const type = /^[a-z][\w-]*/.exec(compound)?.[0];
  if (type && type !== step.type) return false;
  const classes = compound.match(/\.[\w-]+/g)?.map((name) => name.slice(1)) ?? [];
  return classes.every((name) => step.classes.includes(name));
}

/** One compound of a selector, and whether it must be its right neighbour's parent. */
interface Part {
  compound: string;
  child: boolean;
}

function parts(selector: string): Part[] {
  const found: Part[] = [];
  let child = false;
  for (const token of selector
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/)) {
    if (token === '>') {
      child = true;
      continue;
    }
    found.push({ compound: token, child });
    child = false;
  }
  return found;
}

/**
 * Whether a selector matches the last element of a path.
 *
 * Walks right to left, the way a browser does. A compound marked `child` fixes
 * its left neighbour to the step directly above; a descendant may skip any number
 * of steps, which is why this backtracks rather than running as a single pass --
 * and the descendant case is the whole subject of this file.
 */
function selectorMatches(selector: string, path: Step[]): boolean {
  const sequence = parts(selector);
  function matchAt(index: number, step: number): boolean {
    if (step < 0) return false;
    if (!compoundMatches(sequence[index].compound, path[step])) return false;
    if (index === 0) return true;
    if (sequence[index].child) return matchAt(index - 1, step - 1);
    for (let above = step - 1; above >= 0; above -= 1) {
      if (matchAt(index - 1, above)) return true;
    }
    return false;
  }
  return matchAt(sequence.length - 1, path.length - 1);
}

const SHEET = rules(CSS);

/**
 * The value the cascade lands on for one property on one element.
 *
 * Highest specificity wins; equal specificity goes to whichever rule is later in
 * the file, which is the tie-break that decides several of the pairs here.
 */
function resolved(property: string, path: Step[]): string | undefined {
  let winner: Rule | null = null;
  for (const rule of SHEET) {
    if (!rule.declarations.has(property)) continue;
    if (!selectorMatches(rule.selector, path)) continue;
    if (winner === null || rule.specificity >= winner.specificity) winner = rule;
  }
  return winner?.declarations.get(property);
}

/** The map, its open panel, and the panel's own row list. */
const PANEL = [at('div', 'trace-dag', 'map'), at('div', 'dag-detail'), at('dl')];
/** The Result row of that panel, which is where a rendered result is drawn. */
const RESULT = [...PANEL, at('dd')];
/** An agent step's fact grid, as `FactGrid` builds it. */
const FACTS = [...RESULT, at('dl', 'dag-shape', 'dag-facts')];
/** One fact: the `div` holding a label and its value. */
const FACT_ROW = [...FACTS, at('div')];
/** A Genie card's own rows, as `GenieCard` builds them. */
const SHAPE = [...RESULT, at('dl', 'dag-shape')];

describe('the step panel’s own label grid', () => {
  it('is a two-track grid at the handoff’s label width', () => {
    expect(resolved('display', PANEL)).toBe('grid');
    expect(resolved('grid-template-columns', PANEL)).toBe('110px minmax(0, 1fr)');
  });

  it('does not reach the list a rendered result nests inside it', () => {
    // The regression, stated as the two things that were false. Against the
    // descendant selector the fact grid resolves to `grid` at the panel's own
    // 110px, which is what put two facts on a row and left four pixels of value.
    expect(resolved('display', FACTS)).toBe('block');
    expect(resolved('grid-template-columns', FACTS)).not.toBe('110px minmax(0, 1fr)');
    expect(resolved('padding', FACTS)).toBeUndefined();
  });

  it('does not reach a Genie card’s rows either', () => {
    // The same fault, one renderer over, and the reason the fix is the selector
    // rather than a louder rule on `.dag-facts`: this grid asked for a 96px
    // label column and was silently given the panel's 110px, plus the panel's
    // padding, inside a `dd` that is already indented.
    expect(resolved('grid-template-columns', SHAPE)).toBe('96px minmax(0, 1fr)');
    expect(resolved('padding', SHAPE)).toBeUndefined();
  });
});

describe('a fact’s own row', () => {
  it('lays out its label and value as one pair', () => {
    expect(resolved('display', FACT_ROW)).toBe('grid');
    expect(resolved('grid-template-columns', FACT_ROW)).toBe('96px minmax(0, 1fr)');
  });

  it('lets the value column shrink instead of the label pushing it to nothing', () => {
    // `1fr` on its own is `minmax(auto, 1fr)`: the track refuses to go under the
    // width of its content, so a sixty-character table name takes the row and the
    // value beside it wraps one word per line. Every label grid on this surface is
    // written `minmax(0, 1fr)` for that reason, so this is asserted over all of
    // them rather than only on the one that was reported. The `minmax` calls are
    // removed first, because the `1fr` inside one of them is the fixed form.
    for (const path of [PANEL, FACTS, FACT_ROW, SHAPE]) {
      const tracks = resolved('grid-template-columns', path) ?? '';
      expect(tracks.replace(/minmax\([^)]*\)/g, 'ok')).not.toContain('1fr');
    }
  });
});

describe('a table or column name too long for its row', () => {
  it('is cut with an ellipsis rather than widening the grid', () => {
    const chip = [...FACT_ROW, at('dd'), at('div', 'dag-md'), at('code', 'dag-name-chip')];

    expect(resolved('overflow', chip)).toBe('hidden');
    expect(resolved('text-overflow', chip)).toBe('ellipsis');
    expect(resolved('max-width', chip)).toBe('100%');
  });
});
