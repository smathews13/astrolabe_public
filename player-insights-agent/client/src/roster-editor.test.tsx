/**
 * The roster row must not be able to offer a change the server would refuse.
 *
 * Every test here is a way the panel could disagree with the route. Each of the
 * disagreements looks tidier on screen than the truth, which is why they need a test
 * rather than a comment: a menu with all three roles in it always looks more
 * complete than one with two, and a Remove button on every row looks more consistent
 * than one that is sometimes absent.
 *
 * Rendered rather than asserted against the source, because this repository has
 * shipped screens that were wrong while every test passed by checking the source of
 * a component nobody rendered.
 *
 * Every address here is invented. The people this feature exists for are at a
 * customer domain, and a real address in a test file is a real address in the
 * published tree.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RosterRows } from './UserRoleEditor';
import {
  accessOwed,
  canSubmit,
  originLabel,
  roleWord,
  rosterSummary,
  rowLocked,
  setOn,
  stepsDownFrom,
} from './user-roster';
import { badgeAnnouncement, badgeLabel, badgeTitle, roleFrom, showsAdminSurfaces, showsUserRoster } from './role';
import type { Role, RosterEntry, RosterMutationPayload } from '../../shared/user-roster-contract';
import { partial } from './styles/stylesheet';

const LEAD = 'lead@example.invalid';
const DEPUTY = 'deputy@example.invalid';
const ANALYST = 'analyst@example.invalid';

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function entry(over: Partial<RosterEntry> & { email: string; role: Role }): RosterEntry {
  return {
    seedFloor: 'consumer',
    setBy: LEAD,
    setAt: '2026-08-17T00:00:00.000Z',
    isYou: false,
    assignable: [],
    canRemove: false,
    ...over,
  };
}

function rows(over: Partial<RosterMutationPayload> & { entries: RosterEntry[] }): string {
  const full: RosterMutationPayload = {
    entries: over.entries,
    storedRosterReadable: over.storedRosterReadable ?? true,
    roleColumnPresent: over.roleColumnPresent ?? true,
    pendingSchemaStatement: over.pendingSchemaStatement ?? '',
    superAdminCount: over.superAdminCount ?? over.entries.filter((row) => row.role === 'super_admin').length,
    recoveryStatement: over.recoveryStatement ?? '',
    access: over.access ?? [],
  };
  return renderToStaticMarkup(<RosterRows payload={full} busy={false} onChange={() => {}} onRemove={() => {}} />);
}

describe('the row offers only what the server allows', () => {
  it('draws no role control at all when the server offers no role', () => {
    // A seeded row. The environment would restore the role on the next request, so a
    // control here would appear to work and would not.
    const markup = rows({ entries: [entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' })] });
    expect(markup).not.toContain('<select');
    expect(text(markup)).toContain('Super admin');
  });

  it('draws no Remove button when the server would refuse the removal', () => {
    const markup = rows({ entries: [entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' })] });
    expect(markup).not.toContain(`Remove ${LEAD}`);
  });

  it('offers exactly the roles the server named, and the one held', () => {
    const markup = rows({
      entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'] })],
    });
    expect(markup).toContain('<select');
    expect(markup).toContain('value="admin"');
    expect(markup).toContain('value="consumer"');
    // Not offered, because the server did not offer it.
    expect(markup).not.toContain('value="super_admin"');
  });

  it('names the row in the control, so a screen reader is not given a bare menu', () => {
    expect(rows({ entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'] })] })).toContain(
      `Role for ${ANALYST}`
    );
  });
});

describe('why a row is locked', () => {
  const locked = (over: Partial<RosterEntry> & { email: string; role: Role }, payload: Partial<RosterMutationPayload>) =>
    rowLocked(entry(over), {
      entries: [],
      storedRosterReadable: true,
      roleColumnPresent: true,
      pendingSchemaStatement: '',
      superAdminCount: 1,
      recoveryStatement: '',
      access: [],
      ...payload,
    });

  it('points at the deployment configuration for a seeded row', () => {
    expect(locked({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' }, {})).toBe(
      'Change this in the deployment configuration.'
    );
  });

  it('says the roster cannot record other roles yet when the column is absent', () => {
    expect(locked({ email: ANALYST, role: 'admin' }, { roleColumnPresent: false })).toBe(
      'This roster cannot record other roles yet.'
    );
  });

  it('says which row is the only super admin', () => {
    expect(locked({ email: LEAD, role: 'super_admin' }, { superAdminCount: 1 })).toBe('The only super admin.');
  });

  it('says nothing when the row has controls', () => {
    expect(locked({ email: ANALYST, role: 'consumer', assignable: ['admin'] }, {})).toBe('');
  });
});

describe('the way back into a deployment nobody can administer', () => {
  it('prints the statement when the server sent one', () => {
    const statement = "INSERT INTO player_insights.admin_emails (email, role, added_by) VALUES ('<address>', 'super_admin', '<who>')";
    const markup = rows({ entries: [], recoveryStatement: statement });
    expect(text(markup)).toContain('super_admin');
    expect(markup).toContain('Appoint a super admin');
  });

  it('prints nothing when the server withheld it', () => {
    expect(rows({ entries: [entry({ email: LEAD, role: 'super_admin' })] })).not.toContain('Appoint a super admin');
  });

  it('prints the pending schema statement when the roster cannot record a role', () => {
    const markup = rows({
      entries: [],
      roleColumnPresent: false,
      pendingSchemaStatement: 'ALTER TABLE player_insights.admin_emails ADD COLUMN IF NOT EXISTS role TEXT',
    });
    expect(markup).toContain('Add the role column');
  });
});

describe('the line above the roster', () => {
  const payload = (over: Partial<RosterMutationPayload> & { entries: RosterEntry[] }): RosterMutationPayload => ({
    storedRosterReadable: true,
    roleColumnPresent: true,
    pendingSchemaStatement: '',
    superAdminCount: over.entries.filter((row) => row.role === 'super_admin').length,
    recoveryStatement: '',
    access: [],
    ...over,
  });

  it('says the stored half could not be read rather than drawing it empty', () => {
    const summary = rosterSummary(payload({ entries: [entry({ email: LEAD, role: 'super_admin' })], storedRosterReadable: false }));
    expect(summary).toContain('could not be read');
    expect(summary).toContain('Nobody has lost a role.');
  });

  it('says a deployment with nobody on it has nobody, which is a different fact', () => {
    expect(rosterSummary(payload({ entries: [] }))).toContain('no administrators');
  });

  it('counts the administrators and how many of them are super', () => {
    const summary = rosterSummary(
      payload({
        entries: [
          entry({ email: LEAD, role: 'super_admin' }),
          entry({ email: DEPUTY, role: 'admin' }),
          entry({ email: ANALYST, role: 'consumer' }),
        ],
      })
    );
    expect(summary).toContain('2 administrators, 1 of them super');
    expect(summary).toContain('3 people');
  });
});

describe('the telemetry grant a new administrator needs', () => {
  const refused = {
    access: [
      {
        email: ANALYST,
        results: [
          { state: 'refused', grant: { statement: 'GRANT SELECT ON SCHEMA `c`.`s` TO `analyst@example.invalid`;' } },
          { state: 'already-held', grant: null },
        ],
      },
    ],
  };

  it('collects the statement somebody with authority runs', () => {
    expect(accessOwed(refused)).toEqual(['GRANT SELECT ON SCHEMA `c`.`s` TO `analyst@example.invalid`;']);
  });

  it('collects nothing when nothing was refused', () => {
    expect(accessOwed({ access: [{ email: ANALYST, results: [{ state: 'granted', grant: null }] }] })).toEqual([]);
  });

  it('does not print one statement twice', () => {
    const twice = { access: [refused.access[0], refused.access[0]] };
    expect(accessOwed(twice)).toHaveLength(1);
  });
});

describe('a super admin stepping down is told before the panel goes', () => {
  const me = entry({ email: LEAD, role: 'super_admin', isYou: true, assignable: ['admin', 'consumer'] });

  it('names what is lost on the way to consumer', () => {
    expect(stepsDownFrom(me, 'consumer')).toContain('Monitoring, Ops');
  });

  it('names what is lost on the way to admin', () => {
    expect(stepsDownFrom(me, 'admin')).toContain('change roles');
  });

  it('says nothing about somebody else', () => {
    expect(stepsDownFrom(entry({ email: DEPUTY, role: 'super_admin' }), 'admin')).toBe('');
  });

  it('says nothing about a rise', () => {
    expect(stepsDownFrom(me, 'super_admin')).toBe('');
  });
});

describe('the row says where a role came from', () => {
  it('calls a seeded row deployment configuration', () => {
    expect(originLabel(entry({ email: LEAD, role: 'super_admin', seedFloor: 'admin' }))).toBe('Set at deployment');
  });

  it('names who set a stored role', () => {
    expect(originLabel(entry({ email: ANALYST, role: 'admin' }))).toBe(`Set by ${LEAD}`);
  });

  it('never guesses a date it was not given', () => {
    expect(setOn(entry({ email: ANALYST, role: 'admin', setAt: '' }))).toBe('');
    expect(setOn(entry({ email: ANALYST, role: 'admin', setAt: 'not a date' }))).toBe('');
  });
});

describe('the badge and the layout', () => {
  it('calls the rank Super admin, never an initial', () => {
    expect(badgeLabel('super_admin')).toBe('Super admin');
  });

  it('gives both administrator ranks the admin layout', () => {
    expect(showsAdminSurfaces('super_admin')).toBe(true);
    expect(showsAdminSurfaces('admin')).toBe(true);
    expect(showsAdminSurfaces('consumer')).toBe(false);
  });

  it('draws the roster for the super admin only', () => {
    expect(showsUserRoster('super_admin')).toBe(true);
    expect(showsUserRoster('admin')).toBe(false);
    expect(showsUserRoster('failed')).toBe(false);
  });

  it('reads the rank off the identity payload', () => {
    expect(roleFrom({ signedInAs: LEAD, role: 'super_admin' }).state).toBe('super_admin');
  });

  it('still resolves a role it does not know as unknown rather than guessing', () => {
    expect(roleFrom({ signedInAs: LEAD, role: 'owner' }).state).toBe('failed');
  });

  it('names the one thing the rank adds, rather than repeating the Admin line', () => {
    expect(badgeTitle('super_admin')).not.toBe(badgeTitle('admin'));
    expect(badgeTitle('super_admin')).toContain('who else');
  });

  it('speaks the loss of the rank, because a control has just left the page', () => {
    expect(badgeAnnouncement('super_admin', 'admin')).toContain('now an admin');
  });

  it('stays silent on gaining it', () => {
    expect(badgeAnnouncement('admin', 'super_admin')).toBe('');
  });

  it('stays silent on the first resolve', () => {
    expect(badgeAnnouncement('resolving', 'super_admin')).toBe('');
  });
});

describe('the controls are the app\'s own', () => {
  it('gives the role select the app\'s control radius and hairline', () => {
    expect(partial('settings.css')).toMatch(/\.roster-role-select \{[^}]*border-radius: var\(--radius-sm\)/);
    expect(partial('settings.css')).toMatch(/\.roster-role-select \{[^}]*border: 1px solid var\(--border\)/);
  });

  it('holds the locked line in the column the select would occupy', () => {
    expect(partial('settings.css')).toMatch(/\.roster-row-locked \{[^}]*text-align: right/);
  });
});

describe('the Add button', () => {
  it('does nothing until there is something to add', () => {
    expect(canSubmit('', false)).toBe(false);
    expect(canSubmit('  ', false)).toBe(false);
    expect(canSubmit(ANALYST, true)).toBe(false);
    expect(canSubmit(ANALYST, false)).toBe(true);
  });
});

describe('the word for each role', () => {
  it.each<[Role, string]>([
    ['super_admin', 'Super admin'],
    ['admin', 'Admin'],
    ['consumer', 'Consumer'],
  ])('%s reads as "%s"', (role, word) => {
    expect(roleWord(role)).toBe(word);
  });
});
