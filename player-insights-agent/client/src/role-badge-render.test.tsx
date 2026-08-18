/**
 * That the header actually draws a role badge, and what it says in each of the
 * four states.
 *
 * THE FIRST TEST IN THIS FILE IS THE POINT OF THE FILE. role.ts computed all
 * four states, both tooltips, the accessible names, the live-region wording and
 * the badge-then-name-then-gear order, and had thorough tests for every one of
 * them, all passing. Nothing in the app called any of it. The component those
 * tests describe -- RoleBadge.tsx, named in role.ts's own comments -- had never
 * been written, so the header simply had no badge, and it shipped that way. Not
 * one existing test failed, because every one of them tested the module.
 *
 * That is the same failure nav-role.test.tsx was written for, a tab row that
 * role.ts specified and Layout.tsx did not draw, and the lesson took twice. So
 * the assertion below renders the HEADER and fails when there is no badge in it.
 * A test of `badgeLabel` cannot fail for a missing caller; only this can.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. It is markup, wording and the rules in
 * shell.css. Nothing here says the chip fits beside the name.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { Layout, IdentityChips } from './Layout';
import { RoleBadge } from './RoleBadge';
import { badgeLabel, badgeTitle, roleFrom, type RoleResolution, type RoleState } from './role';
import { identityAfterDeadline, IDENTITY_DEADLINE_MS } from './app-state';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';
import type { Identity } from './app-types';
import { partial } from './styles/stylesheet';
import { acknowledgeFirstOpen } from './first-open';

const ALL_STATES: RoleState[] = ['resolving', 'admin', 'consumer', 'failed'];

function resolution(state: RoleState): RoleResolution {
  return { state, addedAdminsReadable: true };
}

function identity(signedInAs = '<your-username>'): Identity {
  return {
    signedInAs,
    executionIdentity: 'Player Insights service principal',
    executionMode: 'service-principal',
  };
}

/** The badge on its own. */
function badge(state: RoleState): string {
  return renderToStaticMarkup(<RoleBadge state={state} />);
}

/**
 * The whole header, as the app mounts it once the login gate has been passed.
 *
 * THE ACKNOWLEDGEMENT IS NOT INCIDENTAL SETUP. The layout draws no header at all
 * while the first-open gate is still deciding whether to show, which is the fix for
 * the flicker that used to put the Ask tab on screen for a second and then cover it
 * with a login card. So "the header" is a thing that exists on the far side of the
 * gate, and a header test has to say which session it is looking at. `null` as the
 * store keeps it to this module's own in-memory latch: there is no `window` in this
 * run, and nothing here should write to a real one.
 */
function header(): string {
  acknowledgeFirstOpen(null);
  return renderToStaticMarkup(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>
  );
}

/** The cluster the badge and the name share, at either width. */
function cluster(state: RoleState, className?: string): string {
  return renderToStaticMarkup(
    <IdentityChips identity={identity()} role={resolution(state)} className={className} />
  );
}

describe('the header draws a badge at all', () => {
  it('renders one, which is the assertion that was missing when it rendered none', () => {
    // Deliberately the weakest possible claim about the badge, and the only one
    // that would have caught this. Everything else in this file could pass with
    // no component in the tree.
    expect(header()).toContain('data-testid="role-badge"');
  });

  it('puts it inside the identity cluster rather than loose in the header', () => {
    // Which is what gets it into the mobile sheet as well, from the same
    // component and in the same order, instead of being a header-only element
    // that a narrow window silently drops.
    expect(cluster('admin')).toContain('data-testid="role-badge"');
    expect(cluster('admin', 'mobile-identity')).toContain('data-testid="role-badge"');
  });

  it('hands it the role the header already derived rather than reading it again', () => {
    // The badge takes a state and draws it. If it ever fetches or infers one,
    // there are two answers to the question role.ts exists to answer once.
    const source = readFileSync(new URL('RoleBadge.tsx', import.meta.url), 'utf8')
      // Comments stripped, so prose naming the hook is not read as a call to it.
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(source).not.toMatch(/fetch\(|useIdentity|roleFrom/);
  });
});

describe('badge, then who, then who built it, then the gear', () => {
  it('draws the badge to the LEFT of the reader it qualifies', () => {
    // Binding, and already corrected once: the design handoff puts it on the
    // right and this app puts it on the left. role.ts records the order and the
    // reasoning as HEADER_CLUSTER_ORDER; this is the assertion that the markup
    // agrees with it.
    //
    // The reader is an avatar now rather than a "Signed in <name>" chip (§1), so
    // the second landmark moved. The claim did not: the badge qualifies whoever
    // it precedes, and the attribution closes the row behind both.
    const markup = cluster('admin');
    const at = (needle: string) => markup.indexOf(needle);
    expect(at('role-badge')).toBeGreaterThan(-1);
    expect(at('identity-avatar')).toBeGreaterThan(-1);
    expect(at('role-badge')).toBeLessThan(at('identity-avatar'));
    expect(at('identity-avatar')).toBeLessThan(at('built-on-databricks'));
  });

  it('is not flipped back by the stylesheet', () => {
    // The order comes from the markup, so a `row-reverse` or an `order:` on
    // either chip would put what is painted and what is read out into
    // disagreement without touching a line of this component.
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rule = shell.match(/\.identity-chips\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule, 'shell.css still has .identity-chips').not.toEqual('');
    expect(rule).not.toMatch(/row-reverse/);
    const badgeRules = [...shell.matchAll(/\.role-badge[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(badgeRules.length).toBeGreaterThan(0);
    // `order:` and not `border:`, which is why the property is anchored to the
    // start of a declaration rather than matched loose.
    for (const body of badgeRules) expect(body).not.toMatch(/(^|[;{\s])order\s*:/);
  });
});

describe('all four states reach the screen, and none of them is blank prose', () => {
  it('says Admin and Consumer in words rather than as an initial', () => {
    expect(badge('admin')).toContain('Admin');
    expect(badge('consumer')).toContain('Consumer');
    // "A" and "C" would be indistinguishable from the initials the header draws
    // elsewhere, which is why role.ts refuses to abbreviate them.
    expect(badge('admin')).not.toMatch(/>A</);
  });

  it('says Role unknown when the role could not be read', () => {
    expect(badge('failed')).toContain('Role unknown');
    expect(badge('failed')).toContain(badgeTitle('failed'));
  });

  it('draws the resolving chip empty, and reserves its width so nothing jumps', () => {
    const markup = badge('resolving');
    expect(markup).toContain("data-role-state=\"resolving\"");
    // Empty of text, which is the specification, and hidden from assistive
    // technology because "Role:" with nothing after it is worse than silence.
    expect(markup).toMatch(/data-testid="role-badge"[^>]*><\/span>/);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('aria-label');
  });

  it('gives every state a distinct rule, so none of them paints as another', () => {
    const shell = partial('shell.css');
    for (const state of ALL_STATES) {
      expect(shell, `shell.css styles the ${state} badge`).toContain(`.role-badge[data-role-state='${state}']`);
    }
  });

  /**
   * A PILL AND NEVER A BUTTON, which is the point of the geometry rather than a
   * preference about corners. `role-badge.md` states it plainly: every button in
   * this app is 4px with a border, so a 999px pill with no border cannot be
   * mistaken for one, and there is nothing here to press.
   *
   * This replaces a test that asserted the opposite geometry -- one reserved
   * `--role-badge-w` across all four states, built on the identity chip's 4px
   * radius and 1px border -- and it is worth recording why rather than leaving a
   * silent reversal. That treatment was correct against the earlier guidance and
   * it did buy something real: the header's right-hand cluster did not shift when
   * the role landed. The handoff specifies a 64px resolving pill, which is
   * narrower than every label that replaces it, so the cluster now does shift.
   * That is the handoff's trade and not a defect here. Widening it back would be
   * quietly overruling a specified dimension.
   */
  it('is a pill with no border in any state, so it cannot read as a button', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const base = shell.match(/\.role-badge\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(base, 'shell.css still has a .role-badge base rule').not.toEqual('');
    expect(base).toMatch(/border-radius:\s*999px/);
    expect(base).toMatch(/padding:\s*3px 10px/);
    expect(base).toMatch(/font-size:\s*12px/);
    expect(base).toMatch(/font-weight:\s*500/);
    // `border: 0` rather than an omission. An omitted border is a border the next
    // edit adds without noticing it is the one thing that breaks the shape.
    expect(base).toMatch(/border:\s*0/);

    // And no state may put one back, which is the instruction the handoff repeats.
    for (const state of ALL_STATES) {
      const rule = shell.match(new RegExp(`\\.role-badge\\[data-role-state='${state}'\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, `shell.css styles the ${state} badge`).not.toEqual('');
      expect(rule, `the ${state} badge must not draw a border`).not.toMatch(/border(-color)?:\s*(?!0)/);
    }
  });

  /**
   * The two families the palette declares for this pill, asked for by name.
   *
   * WHAT THIS CAUGHT. Three of the four states painted --db-chip #E8ECF0 on
   * --db-grey-blue #445461, which are DuBois values that predate the astrolabe
   * neutral: §2 gives neutral as #46596B on #F2F6F9. So the pill a reader sees
   * three times out of four was a slightly different grey from every neutral chip
   * on the pages under it, on the same screen, and the difference is the kind
   * nobody reports and everybody notices.
   *
   * Pinned as token NAMES rather than as hex, because the point is that the pill
   * takes the family. A rule that hardcoded #F2F6F9 would satisfy a hex test and
   * be the same defect one palette change later.
   */
  it('takes its fills from the palette rather than from the DuBois greys', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const ruleFor = (state: RoleState) =>
      shell.match(new RegExp(`\\.role-badge\\[data-role-state='${state}'\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '';

    // Admin is the info family: §2 names role chips as one of the three things
    // that take it.
    expect(ruleFor('admin')).toMatch(/background:\s*var\(--ast-info-fill\)/);
    expect(ruleFor('admin')).toMatch(/color:\s*var\(--ast-info-text\)/);

    // Consumer and Role unknown share one rule and both are neutral. The word is
    // the whole distinction between them, which is why they can share a colour.
    expect(ruleFor('failed')).toMatch(/background:\s*var\(--ast-neutral-fill\)/);
    expect(ruleFor('failed')).toMatch(/color:\s*var\(--ast-neutral-text\)/);
    expect(shell).toContain(".role-badge[data-role-state='consumer'],");

    // And the placeholder has to be the same grey as the pill that replaces it in
    // three of the four states, or the shift shows at the moment the role lands.
    expect(ruleFor('resolving')).toMatch(/background:\s*var\(--ast-neutral-fill\)/);

    // None of the four may name a colour of its own.
    for (const state of ALL_STATES) expect(ruleFor(state)).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it('draws the resolving pill at the size the handoff gives it', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const resolving = shell.match(/\.role-badge\[data-role-state='resolving'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(resolving).toMatch(/width:\s*64px/);
    expect(resolving).toMatch(/height:\s*22px/);
  });

  /**
   * The one state with a mark, and the reason it is the only one: Admin means
   * extra surfaces are on the page. Consumer is explicitly given no icon.
   */
  it('gives Admin the shield and gives no other state an icon', () => {
    expect(badge('admin')).toContain('<svg');
    expect(badge('consumer')).not.toContain('<svg');
    expect(badge('failed')).not.toContain('<svg');
    expect(badge('resolving')).not.toContain('<svg');
    // Hidden, because the pill is already named "Role: Admin" and a shield
    // announced beside that is a second wordless copy of the word next to it.
    expect(badge('admin')).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('names each state in the markup, so a stuck one can be told from a missing one', () => {
    // The defect this whole item came from: a badge that was never written and a
    // badge stuck resolving are the same pixels. They are no longer the same
    // markup.
    for (const state of ALL_STATES) {
      expect(badge(state)).toContain(`data-role-state="${state}"`);
    }
  });
});

describe('an unresolved read ends up saying Role unknown rather than staying blank', () => {
  it('turns a read that never landed into the unavailable identity', () => {
    // The third outcome, and it had no handling: a fetch that neither resolves
    // nor rejects left the hook on the resolving placeholder for as long as the
    // tab was open, so the chip stayed empty forever.
    expect(identityAfterDeadline(identity(IDENTITY_RESOLVING)).signedInAs).toBe(IDENTITY_UNAVAILABLE);
  });

  it('leaves an answer that beat the deadline alone', () => {
    // A slow success is still a success. A deadline that overwrote it would
    // report a failure that did not happen.
    const answered = identity('<your-username>');
    expect(identityAfterDeadline(answered)).toBe(answered);
    const refused = identity(IDENTITY_UNAVAILABLE);
    expect(identityAfterDeadline(refused)).toBe(refused);
  });

  it('lands on the visible failed badge, which is the whole chain', () => {
    // The claim end to end: unanswered read -> unavailable identity -> failed
    // role -> a chip that says something. Each link is tested above or in
    // role.ts's own suite; this is the one that fails if a link is re-wired.
    const stuck = identityAfterDeadline(identity(IDENTITY_RESOLVING));
    expect(roleFrom(stuck).state).toBe('failed');
    expect(badgeLabel(roleFrom(stuck).state)).toBe('Role unknown');
    expect(badge(roleFrom(stuck).state)).toContain('Role unknown');
  });

  it('waits long enough to be a verdict rather than a stopwatch', () => {
    // Short enough that nobody sits in front of an empty chip, long enough that
    // a cold container is not reported as a failure. If this ever drops to a
    // couple of seconds it will start calling slow reads broken.
    expect(IDENTITY_DEADLINE_MS).toBeGreaterThanOrEqual(8_000);
    expect(IDENTITY_DEADLINE_MS).toBeLessThanOrEqual(30_000);
  });
});
