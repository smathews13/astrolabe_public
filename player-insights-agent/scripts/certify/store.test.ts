import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueCertificate, type Attestation } from './certificate.ts';
import { emptyTuple, tupleDigest, type ReleaseTuple } from './release-identity.ts';
import {
  addAttestation,
  certificateFilename,
  latestFor,
  readAttestations,
  readCertificates,
  writeCertificate,
} from './store.ts';

const TUPLE: ReleaseTuple = {
  ...emptyTuple(),
  target: 'demo',
  appName: 'app',
  appBuildSha: 'a'.repeat(40),
  servingEndpoint: 'endpoint',
  modelName: 'cat.sch.model',
  modelVersion: '19',
  modelBuildSha: 'a'.repeat(40),
  declaredScopes: ['sql'],
};

function certificate(tuple: ReleaseTuple, at: string) {
  return issueCertificate({
    tuple,
    checks: [],
    attestations: [],
    mode: 'shadow',
    issuedBy: 'someone@example.com',
    now: new Date(at),
  });
}

let store: string;
beforeEach(() => {
  store = mkdtempSync(path.join(tmpdir(), 'pia-certify-'));
});

describe('certificates on disk', () => {
  it('names a file so the newest for a release sorts last', () => {
    const early = certificateFilename(certificate(TUPLE, '2026-08-10T09:00:00.000Z'));
    const late = certificateFilename(certificate(TUPLE, '2026-08-10T11:00:00.000Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('carries the release digest and the verdict in the filename', () => {
    const name = certificateFilename(certificate(TUPLE, '2026-08-10T09:00:00.000Z'));
    expect(name).toContain(tupleDigest(TUPLE).slice(0, 12));
    expect(name).toContain('INCOMPLETE');
  });

  it('round-trips, newest first', () => {
    writeCertificate(store, certificate(TUPLE, '2026-08-10T09:00:00.000Z'));
    writeCertificate(store, certificate(TUPLE, '2026-08-10T11:00:00.000Z'));
    const found = readCertificates(store, 'demo');
    expect(found).toHaveLength(2);
    expect(found[0].issuedAt).toBe('2026-08-10T11:00:00.000Z');
  });

  it('finds the newest certificate for exactly one release', () => {
    const moved = { ...TUPLE, modelVersion: '20' };
    writeCertificate(store, certificate(TUPLE, '2026-08-10T09:00:00.000Z'));
    writeCertificate(store, certificate(moved, '2026-08-10T11:00:00.000Z'));
    expect(latestFor(store, TUPLE)?.tupleDigest).toBe(tupleDigest(TUPLE));
    expect(latestFor(store, moved)?.tupleDigest).toBe(tupleDigest(moved));
  });

  it('returns nothing for a release that was never certified', () => {
    expect(latestFor(store, { ...TUPLE, modelVersion: '99' })).toBeNull();
  });

  it('reads an empty store rather than throwing at it', () => {
    expect(readCertificates(store, 'never-used')).toEqual([]);
  });

  it('skips a corrupt file instead of letting it hide a good one beside it', () => {
    writeCertificate(store, certificate(TUPLE, '2026-08-10T09:00:00.000Z'));
    writeFileSync(path.join(store, 'demo', '2026-99-99--broken.json'), 'not json');
    expect(readCertificates(store, 'demo')).toHaveLength(1);
  });

  it('will not let a target name choose a directory outside the store', () => {
    writeCertificate(store, certificate({ ...TUPLE, target: '../escape' }, '2026-08-10T09:00:00.000Z'));
    expect(readdirSync(store)).toEqual(['.._escape']);
  });
});

describe('attestations', () => {
  function statement(overrides: Partial<Attestation> = {}): Attestation {
    return {
      code: 'OAUTH_SCOPE_CONSENT_PROVEN',
      by: 'someone@example.com',
      at: '2026-08-10T09:00:00.000Z',
      note: 'signed in after the restart',
      tupleDigest: tupleDigest(TUPLE),
      ...overrides,
    };
  }

  it('round-trips', () => {
    addAttestation(store, 'demo', statement());
    expect(readAttestations(store, 'demo')).toHaveLength(1);
  });

  it('replaces an earlier statement about the same check and release', () => {
    addAttestation(store, 'demo', statement({ by: 'first@example.com' }));
    addAttestation(store, 'demo', statement({ by: 'second@example.com' }));
    const kept = readAttestations(store, 'demo');
    expect(kept).toHaveLength(1);
    expect(kept[0].by).toBe('second@example.com');
  });

  it('keeps a statement about the same check for a different release', () => {
    addAttestation(store, 'demo', statement());
    addAttestation(store, 'demo', statement({ tupleDigest: tupleDigest({ ...TUPLE, modelVersion: '20' }) }));
    expect(readAttestations(store, 'demo')).toHaveLength(2);
  });

  it('returns nothing for a target with no file, rather than throwing', () => {
    expect(readAttestations(store, 'never-used')).toEqual([]);
  });
});
