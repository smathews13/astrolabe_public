/**
 * The declaration contract, and above all the one thing it must refuse.
 *
 * Every identifier here is invented. A declaration is a customer's own document
 * and their catalogs, schemas and warehouse ids do not belong in a tracked file.
 */
import { describe, expect, it } from 'vitest';
import {
  DECLARABLE_KEYS,
  DECLARATION_FLOW,
  MAX_DECLARED_CONNECTIONS,
  compareDeclaration,
  declarationFlow,
  isDeclarableKey,
  parseDeclaration,
  type NotebookDeclaration,
} from './notebook-declaration';

const DECLARATION = {
  source: '/Workspace/Users/analyst@example.invalid/insights-agent',
  revision: 'rev-41',
  published_at: '2026-08-17T18:00:00.000Z',
  published_by: 'analyst@example.invalid',
  settings: {
    warehouse_id: 'wh-00000000000000aa',
    catalog_allowlist: 'gamesight_share_prod,customer_catalog',
    max_turns: '12',
  },
  connections: [
    {
      id: 'roster-table',
      label: 'Title roster',
      kind: 'unity-catalog',
      value: 'gamesight_share_prod.analytics.title_roster',
      note: 'joined for label breakdowns',
    },
  ],
};

describe('what a published key achieves', () => {
  it('refuses the readable scopes, because that list is what grants the agent its tables', () => {
    expect(declarationFlow('catalog_allowlist')).toBe('refused');
    expect(DECLARATION_FLOW.refused.inForce).toBe(false);
  });

  /**
   * The whole safety argument in one assertion. A key that widens what the agent
   * may read must never be reported as in force off the back of a document the
   * app fetched over the network.
   */
  it('marks nothing that widens the agent’s reach as in force', () => {
    for (const [key, entry] of Object.entries(DECLARABLE_KEYS)) {
      if (DECLARATION_FLOW[entry.flow].inForce) {
        expect.soft(key, `${key} is reported as in force`).toBe('');
      }
    }
  });

  it('treats a key this build has never heard of as recorded, not as in force', () => {
    expect(isDeclarableKey('some_future_knob')).toBe(false);
    expect(declarationFlow('some_future_knob')).toBe('needs-model-version');
    expect(DECLARATION_FLOW[declarationFlow('some_future_knob')].inForce).toBe(false);
  });

  it('gives every declarable key a reason a reader can act on', () => {
    for (const [key, entry] of Object.entries(DECLARABLE_KEYS)) {
      expect.soft(entry.reason.length, `${key} has no reason`).toBeGreaterThan(40);
      expect.soft(entry.label, `${key} has no label`).not.toBe('');
    }
  });
});

describe('reading a published declaration', () => {
  it('keeps the settings and connections a notebook published', () => {
    const parsed = parseDeclaration(DECLARATION);
    expect(parsed?.revision).toBe('rev-41');
    expect(parsed?.publishedBy).toBe('analyst@example.invalid');
    expect(parsed?.settings).toHaveLength(3);
    expect(parsed?.connections[0]).toMatchObject({
      id: 'roster-table',
      kind: 'unity-catalog',
      value: 'gamesight_share_prod.analytics.title_roster',
    });
  });

  it('is not a declaration when it carries neither a setting nor a connection', () => {
    expect(parseDeclaration({ settings: {}, connections: [] })).toBeNull();
    expect(parseDeclaration(null)).toBeNull();
    expect(parseDeclaration([])).toBeNull();
    expect(parseDeclaration('a string')).toBeNull();
  });

  /**
   * One bad row in a hand-maintained list must not cost the reader the page. The
   * survivors are individually complete, which is what makes keeping them safe.
   */
  it('drops a malformed entry and keeps the rest', () => {
    const parsed = parseDeclaration({
      ...DECLARATION,
      connections: [
        { id: 'no-value', label: 'Missing', kind: 'unity-catalog' },
        { id: 'bad-kind', kind: 'app-behaviour', value: 'something' },
        { label: 'no id', kind: 'volume', value: '/Volumes/catalog/schema/volume' },
        DECLARATION.connections[0],
      ],
    });
    expect(parsed?.connections.map((entry) => entry.id)).toEqual(['roster-table']);
  });

  it('refuses a kind that describes the app’s own wiring rather than a customer asset', () => {
    const parsed = parseDeclaration({
      settings: {},
      connections: [{ id: 'rail', kind: 'app-behaviour', value: 'on' }],
    });
    expect(parsed).toBeNull();
  });

  it('does not stringify an object into a value', () => {
    const parsed = parseDeclaration({
      settings: { warehouse_id: { nested: true } },
      connections: [{ id: 'a', kind: 'volume', value: { nested: true } }],
    });
    expect(parsed).toBeNull();
  });

  it('keeps the first of two entries claiming the same id', () => {
    const parsed = parseDeclaration({
      settings: {},
      connections: [
        { id: 'twice', kind: 'volume', value: '/Volumes/catalog/schema/volume/first' },
        { id: 'twice', kind: 'volume', value: '/Volumes/catalog/schema/volume/second' },
      ],
    });
    expect(parsed?.connections).toHaveLength(1);
    expect(parsed?.connections[0].value).toBe('/Volumes/catalog/schema/volume/first');
  });

  it('caps how many connections one declaration may carry', () => {
    const many = Array.from({ length: MAX_DECLARED_CONNECTIONS + 25 }, (_unused, index) => ({
      id: `entry-${index}`,
      kind: 'volume',
      value: `/Volumes/catalog/schema/volume/entry-${index}`,
    }));
    const parsed = parseDeclaration({ settings: {}, connections: many });
    expect(parsed?.connections).toHaveLength(MAX_DECLARED_CONNECTIONS);
  });

  /**
   * The one empty value that is remembered rather than dropped.
   *
   * A notebook writing `DISCOVERY_CATALOG_ALLOWLIST = []` means no restriction.
   * `Settings.from_env` reads an empty allowlist as the deployment's own catalog,
   * which resolves to its configured schema. The parser keeps neither meaning: it
   * records that the value arrived empty, so the tab can state what this side does
   * rather than showing nothing and reading as though the notebook was ignored.
   */
  it('remembers an empty scopes list, while still not recording it as a value', () => {
    const parsed = parseDeclaration({
      ...DECLARATION,
      settings: { warehouse_id: 'wh-00000000000000aa', catalog_allowlist: '' },
    });
    expect(parsed?.emptyScopes).toBe(true);
    expect(parsed?.settings.map((entry) => entry.key)).toEqual(['warehouse_id']);
  });

  it('does not claim an empty scopes list when the notebook named a scope', () => {
    expect(parseDeclaration(DECLARATION)?.emptyScopes).toBe(false);
  });

  it('does not claim an empty scopes list when the notebook never named the key', () => {
    const parsed = parseDeclaration({
      ...DECLARATION,
      settings: { warehouse_id: 'wh-00000000000000aa' },
    });
    expect(parsed?.emptyScopes).toBe(false);
  });

  it('falls back to the id when a connection published no label', () => {
    const parsed = parseDeclaration({
      settings: {},
      connections: [{ id: 'unlabelled', kind: 'sql-warehouse', value: 'wh-00000000000000bb' }],
    });
    expect(parsed?.connections[0].label).toBe('unlabelled');
  });
});

describe('comparing a declaration with what is running', () => {
  const declaration = parseDeclaration(DECLARATION) as NotebookDeclaration;

  it('agrees when the published value is the one in use', () => {
    const [warehouse] = compareDeclaration(declaration, { warehouse_id: 'wh-00000000000000aa' });
    expect(warehouse.verdict).toBe('agrees');
  });

  it('is pending, not applied, when a re-log would carry the change', () => {
    const compared = compareDeclaration(declaration, { warehouse_id: 'wh-00000000000000cc' });
    expect(compared[0].verdict).toBe('pending');
    expect(compared[0].live).toBe('wh-00000000000000cc');
  });

  /**
   * A widened scope list reads as refused rather than pending. Pending promises a
   * re-log will apply it; this app will not apply it from a published document at
   * all, and the two must not read alike.
   */
  it('reports a differing scope list as refused rather than pending', () => {
    const compared = compareDeclaration(declaration, {
      catalog_allowlist: 'gamesight_share_prod',
    });
    const scopes = compared.find((entry) => entry.key === 'catalog_allowlist');
    expect(scopes?.verdict).toBe('refused');
  });

  it('is unknown, not drift, when nothing was read to compare against', () => {
    for (const compared of compareDeclaration(declaration, {})) {
      expect.soft(compared.verdict, `${compared.key} claimed a verdict`).toBe('unknown');
    }
  });

  it('labels a published key with the deployment’s own name for it', () => {
    const compared = compareDeclaration(declaration, {});
    expect(compared.find((entry) => entry.key === 'warehouse_id')?.label).toBe('SQL warehouse');
  });
});
