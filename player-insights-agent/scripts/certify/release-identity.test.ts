import { describe, expect, it } from 'vitest';
import {
  describeTuple,
  dirtyStamps,
  emptyTuple,
  sameRelease,
  tupleDigest,
  unknownFields,
  type ReleaseTuple,
} from './release-identity.ts';

function complete(overrides: Partial<ReleaseTuple> = {}): ReleaseTuple {
  return {
    ...emptyTuple(),
    target: 'demo',
    appName: 'player-insights-agent',
    appBuildSha: 'a'.repeat(40),
    servingEndpoint: 'player-insights-agent',
    modelName: 'cat.sch.player_insights_agent',
    modelVersion: '19',
    modelBuildSha: 'a'.repeat(40),
    declaredScopes: ['sql', 'model-serving'],
    manifestTables: ['cat.sch.b', 'cat.sch.a'],
    userAuthPolicy: 'unknown',
    ...overrides,
  };
}

describe('unknownFields', () => {
  it('reports nothing for a tuple that identifies a release', () => {
    expect(unknownFields(complete())).toEqual([]);
  });

  it('names every identifying field that is empty', () => {
    const missing = unknownFields(complete({ appBuildSha: '', modelVersion: '' }));
    expect(missing).toEqual(['appBuildSha', 'modelVersion']);
  });

  it('treats whitespace as unknown, so a blank stamp cannot pass as a value', () => {
    expect(unknownFields(complete({ modelBuildSha: '   ' }))).toEqual(['modelBuildSha']);
  });

  it('counts an empty scope list as unknown', () => {
    expect(unknownFields(complete({ declaredScopes: [] }))).toEqual(['declaredScopes']);
  });

  it('does not count an empty manifest as unknown, because reading nothing is legitimate', () => {
    expect(unknownFields(complete({ manifestTables: [] }))).toEqual([]);
  });
});

describe('dirtyStamps', () => {
  it('finds a dirty app build', () => {
    expect(dirtyStamps(complete({ appBuildSha: 'abc+dirty' }))).toEqual(['abc+dirty']);
  });

  it('finds both', () => {
    expect(dirtyStamps(complete({ appBuildSha: 'a+dirty', modelBuildSha: 'b+dirty' }))).toHaveLength(2);
  });

  it('finds none in a clean release', () => {
    expect(dirtyStamps(complete())).toEqual([]);
  });
});

describe('tupleDigest', () => {
  it('does not depend on the order the arrays arrived in', () => {
    const a = complete({ declaredScopes: ['sql', 'model-serving'], manifestTables: ['x', 'y'] });
    const b = complete({ declaredScopes: ['model-serving', 'sql'], manifestTables: ['y', 'x'] });
    expect(tupleDigest(a)).toBe(tupleDigest(b));
    expect(sameRelease(a, b)).toBe(true);
  });

  it('leaves the caller list untouched, so a later reader sees the order it was given', () => {
    const tuple = complete({ declaredScopes: ['sql', 'model-serving'] });
    tupleDigest(tuple);
    expect(tuple.declaredScopes).toEqual(['sql', 'model-serving']);
  });

  it('changes when the model version moves', () => {
    expect(tupleDigest(complete())).not.toBe(tupleDigest(complete({ modelVersion: '20' })));
  });

  it('changes when a scope is added, which is the case a certificate must not survive', () => {
    const widened = complete({ declaredScopes: ['sql', 'model-serving', 'dashboards.genie'] });
    expect(sameRelease(complete(), widened)).toBe(false);
  });

  it('changes when the manifest gains a table', () => {
    const wider = complete({ manifestTables: ['cat.sch.a', 'cat.sch.b', 'cat.sch.c'] });
    expect(sameRelease(complete(), wider)).toBe(false);
  });

  it('changes when the auth policy state changes', () => {
    expect(sameRelease(complete(), complete({ userAuthPolicy: 'enabled' }))).toBe(false);
  });
});

describe('describeTuple', () => {
  it('renders an unknown field as (unknown) rather than as a blank column', () => {
    const lines = describeTuple(complete({ modelBuildSha: '' })).join('\n');
    expect(lines).toContain('model build        (unknown)');
  });

  it('includes the digest, which is what a promotion is matched on', () => {
    expect(describeTuple(complete()).join('\n')).toContain(tupleDigest(complete()));
  });
});
