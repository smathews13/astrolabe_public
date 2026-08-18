import { describe, expect, it } from 'vitest';

import {
  EMPTY_CATALOG_DENYLIST,
  EMPTY_DATA_CATALOGS,
  SINGLE_SCHEMA_LABEL,
  WHOLE_CATALOG_LABEL,
  classifyDataCatalogEntry,
  dataCatalogFormLabel,
  parseCatalogDenylist,
  parseDataCatalogEntries,
} from './data-catalog-scope';

describe('classifyDataCatalogEntry', () => {
  it('reads a bare catalog as every non-system schema', () => {
    expect(classifyDataCatalogEntry('analytics')).toEqual({
      name: 'analytics',
      form: 'whole-catalog',
    });
  });

  it('reads catalog.schema as this schema only', () => {
    expect(classifyDataCatalogEntry('analytics.demo')).toEqual({
      name: 'analytics.demo',
      form: 'single-schema',
    });
  });

  it('refuses a three-part name rather than inventing a form for it', () => {
    expect(classifyDataCatalogEntry('analytics.demo.players')).toBeNull();
  });

  it('ignores blank and backtick-only noise', () => {
    expect(classifyDataCatalogEntry('')).toBeNull();
    expect(classifyDataCatalogEntry('   ')).toBeNull();
    expect(classifyDataCatalogEntry('`analytics`')).toEqual({
      name: 'analytics',
      form: 'whole-catalog',
    });
  });
});

describe('parseDataCatalogEntries', () => {
  it('keeps order and distinguishes the two forms in one list', () => {
    expect(parseDataCatalogEntries('production, shared.reference_data')).toEqual([
      { name: 'production', form: 'whole-catalog' },
      { name: 'shared.reference_data', form: 'single-schema' },
    ]);
  });

  it('treats an empty configured value as no entries', () => {
    expect(parseDataCatalogEntries('')).toEqual([]);
    expect(parseDataCatalogEntries('  ,  ')).toEqual([]);
  });
});

describe('parseCatalogDenylist', () => {
  it('returns the patterns when any are set', () => {
    expect(parseCatalogDenylist('raw_*, *.scratch')).toEqual(['raw_*', '*.scratch']);
  });

  it('returns nothing for the default empty denylist', () => {
    expect(parseCatalogDenylist('')).toEqual([]);
    expect(parseCatalogDenylist('   ')).toEqual([]);
  });
});

describe('the empty-state copy', () => {
  it('says what an empty read scope means, without calling it unset', () => {
    expect(EMPTY_DATA_CATALOGS.toLowerCase()).toContain('no declared read scope');
    expect(EMPTY_DATA_CATALOGS.toLowerCase()).toContain('query nothing');
    expect(EMPTY_DATA_CATALOGS).not.toMatch(/not set|not configured|—|–/);
  });

  it('reads an empty denylist as the normal case, not a warning', () => {
    expect(EMPTY_CATALOG_DENYLIST).toBe('Nothing excluded.');
    expect(EMPTY_CATALOG_DENYLIST).not.toMatch(/missing|warning|error|not set|—|–/i);
  });

  it('labels the two forms without em dashes', () => {
    expect(dataCatalogFormLabel('whole-catalog')).toBe(WHOLE_CATALOG_LABEL);
    expect(dataCatalogFormLabel('single-schema')).toBe(SINGLE_SCHEMA_LABEL);
    expect(`${WHOLE_CATALOG_LABEL}${SINGLE_SCHEMA_LABEL}`).not.toMatch(/—|–/);
  });
});
