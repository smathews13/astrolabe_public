import { describe, expect, it } from 'vitest';
import {
  carriesEvidence,
  proseOnlyAnswer,
  PROSE_ONLY_ANSWER_CAVEAT,
  PROSE_ONLY_FALLBACK_TAKEAWAY,
} from './prose-only-answer';
import { DEGRADED_ANSWER_MARKER } from './setup-remedies';

const PROSE = 'VLH Online leads the last 30 days.\n\nThe gap widened after the summer update.';

/**
 * Populated sections to assert against, defined here rather than imported.
 *
 * They used to be the app's own stored demo answer, which is gone. Local
 * fixtures are better for this file anyway: what these assertions care about is
 * that a section is non-empty, not what was in it, and a shared constant made
 * the test read as though the prose-only answer had a seed to borrow from.
 */
const SOME_FIGURES = [{ label: 'Title A', value: 100, display: '1,000', comparison: '#1' }];
const SOME_SOURCES = [{ name: '<catalog>.<schema>.some_table', freshness: 'Current' }];
const SOME_SQL = 'SELECT 1';

describe('the answer for a prose-only reply', () => {
  it('keeps every word the agent sent', () => {
    expect(proseOnlyAnswer('msg-1', PROSE).narrative).toBe(PROSE);
  });

  it('carries nothing a reader would read as a measurement', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.figures).toEqual([]);
    expect(answer.charts).toEqual([]);
    expect(answer.sources).toEqual([]);
    expect(answer.sql).toBe('');
    expect(answer.trace.stages).toEqual([]);
  });

  /**
   * The regression this module exists to prevent, asserted section by section
   * rather than on the answer as a whole. A future edit that repopulates one of
   * them passes the test above only if it happens to populate all four.
   */
  it('leaves every evidence section empty, one at a time', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.figures as unknown[]).toHaveLength(0);
    expect(answer.sources as unknown[]).toHaveLength(0);
    expect(answer.sql).toHaveLength(0);
    expect(answer.charts as unknown[]).toHaveLength(0);
  });

  it('mints no trace id, because there is no trace to find', () => {
    // A synthesised id here is worse than none: the Run Explorer and the MLflow
    // link both take it at face value and send someone looking for a trace that
    // was never recorded.
    expect(proseOnlyAnswer('msg-1', PROSE).trace.id).toBe('');
  });

  it('takes the takeaway from the agent, not from a template', () => {
    expect(proseOnlyAnswer('msg-1', PROSE).takeaway).toBe('VLH Online leads the last 30 days.');
  });

  it('skips leading blank lines rather than showing an empty takeaway', () => {
    expect(proseOnlyAnswer('msg-1', `\n\n   \n${PROSE}`).takeaway).toBe(
      'VLH Online leads the last 30 days.'
    );
  });

  it('describes the shape of the reply when there is no first line to use', () => {
    // Not a sentence about the question. A default takeaway with the subject in
    // it would be this module writing a finding.
    expect(proseOnlyAnswer('msg-1', '   ').takeaway).toBe(PROSE_ONLY_FALLBACK_TAKEAWAY);
  });

  it('says what is missing where the client renders it in red', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.caveats).toEqual([PROSE_ONLY_ANSWER_CAVEAT]);
    expect(PROSE_ONLY_ANSWER_CAVEAT.startsWith(DEGRADED_ANSWER_MARKER)).toBe(true);
  });

  it('does not claim tool calls or elapsed time it never measured', () => {
    const answer = proseOnlyAnswer('msg-1', PROSE);
    expect(answer.trace.toolCalls).toBe(0);
    expect(answer.trace.totalMs).toBe(0);
  });
});

describe('whether an answer carries evidence', () => {
  it('is false for the prose-only answer', () => {
    expect(carriesEvidence(proseOnlyAnswer('msg-1', PROSE))).toBe(false);
  });

  it('is true when any one section is populated', () => {
    const empty = proseOnlyAnswer('msg-1', PROSE);
    expect(carriesEvidence({ ...empty, figures: SOME_FIGURES })).toBe(true);
    expect(carriesEvidence({ ...empty, sources: SOME_SOURCES })).toBe(true);
    expect(carriesEvidence({ ...empty, sql: SOME_SQL })).toBe(true);
    expect(carriesEvidence({ ...empty, trace: { ...empty.trace, stages: [{}] } })).toBe(true);
  });

  it('does not count whitespace as SQL', () => {
    expect(carriesEvidence({ ...proseOnlyAnswer('msg-1', PROSE), sql: '   \n' })).toBe(false);
  });

  it('treats an answer missing the fields entirely as carrying nothing', () => {
    // Stored rows predate several of these keys. Reading an absent section as
    // present would put the stored-demo caveat on an answer nobody can check.
    expect(carriesEvidence({})).toBe(false);
  });
});
