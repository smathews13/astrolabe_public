import { describe, expect, it } from 'vitest';
import { slowestStageName } from './progress-labels';
import type { TraceStage } from './answer-shape';

function stage(id: string, name: string, duration: number): TraceStage {
  return {
    id,
    name,
    kind: 'agent',
    start: 0,
    duration,
    status: 'complete',
    calls: 0,
    input: '',
    output: '',
  };
}

/*
 * The elapsed count moved to working-animation.ts and its tests moved with it,
 * to working-animation.test.ts. It used to be one string, "Working on it — 23s",
 * which carried an em dash into live UI copy on the surface a reader looks at
 * longest, and which no caller could set the number of in DM Mono without
 * matching on the words.
 */

describe('slowestStageName', () => {
  it('names the longest stage from the run', () => {
    // Previously the word "Analysis" was hardcoded, so this metric described a
    // stage that need not exist and was wrong whenever another step dominated.
    const stages = [
      stage('s1', 'Chose the next step', 900),
      stage('s2', 'Called genie_query', 21_800),
      stage('s3', 'Prepared the findings', 4_400),
    ];
    expect(slowestStageName(stages)).toBe('Called genie_query');
  });

  it('is not the word Analysis unless a stage is called that', () => {
    expect(slowestStageName([stage('s1', 'Built the charts', 10)])).toBe('Built the charts');
  });

  it('reports nothing when there are no stages, rather than a default', () => {
    expect(slowestStageName([])).toBeNull();
  });

  it('picks a winner deterministically when durations tie', () => {
    const stages = [stage('a', 'First', 500), stage('b', 'Second', 500)];
    expect(slowestStageName(stages)).toBe('First');
  });
});
