/**
 * The evaluation scorer set: what each scorer measures, and what it is allowed
 * to be read as.
 *
 * ONE DEFINITION, THREE ENVIRONMENTS. The scorers themselves are MLflow
 * `@scorer` functions living in `agent/eval/scorers.py`, and the same objects
 * are used for development runs, for the pre-release run, and for production
 * monitoring. This file is not a second implementation of them: it is the
 * vocabulary the app renders them with, so a name and a caveat cannot drift
 * between the Python that produces a number and the pane that displays it.
 *
 * NOTHING HERE GATES A RELEASE. That is a scope decision recorded in the
 * unified plan (X3, "non-gating"), not an oversight and not a temporary state
 * to be tidied up by a later change. `gating: false` is on the record for every
 * entry so that a future reader who wants to gate has to change a declared
 * value rather than discover an omission. See `SCORECARD_NON_GATING_NOTICE`.
 */

/**
 * How a scorer arrives at its value.
 *
 * The distinction is load bearing on screen. A `deterministic` scorer is a
 * property of the answer that code checked; a `judged` scorer is a language
 * model's opinion of the answer, and carries all the caveats the Benchmark
 * Lab's existing judge ledger already spells out; an `operational` scorer is a
 * measurement of the run rather than a statement about its quality, and must
 * never be read as one -- a fast wrong answer scores well on latency.
 */
export type ScorerKind = 'deterministic' | 'judged' | 'operational';

/**
 * What kind of number the scorer reports, so a reader is never left to infer
 * it from the magnitude.
 *
 * `rate` is a proportion of the cases it applied to, `count` and `milliseconds`
 * are absolute. A `rate` of 0.5 and a `count` of 0.5 would render identically
 * without this.
 */
export type ScorerUnit = 'rate' | 'count' | 'milliseconds';

/**
 * Why a scorer reports nothing.
 *
 * `unimplementable` is the important one and is deliberately not the same as
 * "not run yet". It means the check cannot be performed honestly in this
 * deployment as it stands, the reason is stated in `blockedReason`, and no
 * number will appear until the missing precondition exists. A scorer in this
 * state must never render as a pass. The alternative -- shipping a check that
 * runs as an administrator, passes by construction, and reports a green rate --
 * would be worse than reporting nothing, because it would be evidence of a
 * property nobody established.
 */
export type ScorerAvailability = 'reported' | 'unimplementable';

export interface ScorerDefinition {
  id: string;
  /** The column or tile label. */
  label: string;
  kind: ScorerKind;
  unit: ScorerUnit;
  /** One sentence: what a value of this scorer is a claim about. */
  meaning: string;
  availability: ScorerAvailability;
  /** Why no number is reported. Empty unless `availability` is `unimplementable`. */
  blockedReason: string;
  /**
   * Always false. Present as a declared value rather than an absent field, so
   * that gating is a decision someone has to make rather than a default they
   * can drift into.
   */
  gating: false;
}

/**
 * The sentence that has to appear wherever these numbers are shown.
 */
export const SCORECARD_NON_GATING_NOTICE =
  'None of these scorers gates a release. They are reported so a regression is visible and can be argued ' +
  'about; no promotion, deployment or certification step reads them, and none is blocked by a low score. ' +
  'That is a deliberate scope decision, not a step that was skipped.';

/**
 * Why the persona and identity-mismatch scorers report nothing, in the words a
 * reader needs.
 *
 * Kept as one constant because three scorers share the single missing
 * precondition, and three separately-worded explanations of the same gap would
 * read as three different problems.
 */
export const RESTRICTED_PERSONA_ABSENT =
  'This deployment has no second, deliberately-restricted identity to run the check as. Every account that ' +
  'can start an evaluation here is an administrator, and an administrator passes a row-filter or masking ' +
  'check by construction -- the filter is not applied to them. Running it anyway would produce a green ' +
  'result that is evidence of nothing. The scorer is implemented and will report as soon as a restricted ' +
  'persona exists; until then it abstains rather than passing.';

export const SCORER_CATALOG: readonly ScorerDefinition[] = [
  {
    id: 'sql_validity',
    label: 'SQL validity',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'The SQL the answer published parses as Databricks SQL, is read-only, names its tables in full, and ' +
      'projects no column the policy withholds. A property of the statement, not of the figures it returned.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'correctness',
    label: 'Correctness vs labels',
    kind: 'judged',
    unit: 'rate',
    meaning:
      'A judge model checked the answer against the facts the held-out case was labelled with. The labels ' +
      'are about the shape and conduct of a correct answer, never a figure, because the underlying data is ' +
      'regenerated and a labelled number would be wrong by the next rebuild.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'provenance_completeness',
    label: 'Provenance completeness',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'Every figure the answer stated is attributable: the answer named the tables it read, said what it ' +
      'read each for, and published the statement behind its numbers. Says nothing about whether the ' +
      'figures are right.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'tool_selection',
    label: 'Tool selection',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'The run reached the route the case was labelled as needing -- the dictionary, the governed query ' +
      'path, or a refusal before either -- rather than arriving somewhere plausible by another road.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'refusal_quality',
    label: 'Refusal quality',
    kind: 'judged',
    unit: 'rate',
    meaning:
      'On cases whose correct behaviour is to decline, a judge model checked that the response declined, ' +
      'explained the restriction, and published no figures drawn from the restricted data.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'identity_execution_mode',
    label: 'Executed as the caller',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      "The run read governed data under the caller's own credential, proven at the gate, rather than under " +
      "the application's service principal. This is the narrow, checkable half of the identity story: it " +
      'establishes whose grants were in force, not that a wrong identity would have been refused.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'identity_mismatch',
    label: 'Identity mismatch refusal',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'A run whose forwarded credential belongs to someone other than the account it claims to be is ' +
      'refused before any tool exists. Needs a second identity to present, which is exactly what this ' +
      'deployment has none of.',
    availability: 'unimplementable',
    blockedReason: RESTRICTED_PERSONA_ABSENT,
    gating: false,
  },
  {
    id: 'persona_row_filter',
    label: 'Per-persona row filter',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'The same question asked by a restricted persona returns strictly fewer rows than it does for an ' +
      'unrestricted one, because the governed row filter applied to them and not to the app.',
    availability: 'unimplementable',
    blockedReason: RESTRICTED_PERSONA_ABSENT,
    gating: false,
  },
  {
    id: 'persona_column_mask',
    label: 'Per-persona column masking',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'A column a restricted persona may not read comes back masked for them and unmasked for an ' +
      'unrestricted one, under the same question.',
    availability: 'unimplementable',
    blockedReason: RESTRICTED_PERSONA_ABSENT,
    gating: false,
  },
  {
    id: 'coverage_caveat',
    label: 'Coverage caveat',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'On cases labelled as having a known gap -- a partial window, an excluded population, a definition ' +
      'the data does not settle -- the answer said so, rather than reporting a clean figure over an ' +
      'incomplete base.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'semantic_recall',
    label: 'Semantic recall',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'The semantic search returned the entity the case was labelled as needing. Recall over the labelled ' +
      'entity only: it does not say the ranking was good, and it is not precision.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'stale_index',
    label: 'Stale semantic index',
    kind: 'deterministic',
    unit: 'rate',
    meaning:
      'The semantic index the run searched described the tables the run actually read. A `no` means the ' +
      'index has drifted from the governed schema, so a miss above may be staleness rather than ranking.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'latency_ms',
    label: 'Latency',
    kind: 'operational',
    unit: 'milliseconds',
    meaning:
      "The run's own measured wall time, median across the set. A measurement of the run, not a statement " +
      'about the answer: a fast wrong answer scores well here.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'total_tokens',
    label: 'Tokens',
    kind: 'operational',
    unit: 'count',
    meaning:
      'Prompt and completion tokens summed across the turn, median across the set. Zero means the endpoint ' +
      'returned no usage block, not that the run was free.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'warehouse_calls',
    label: 'Warehouse usage',
    kind: 'operational',
    unit: 'count',
    meaning:
      'Calls the run made to a governed data surface -- the SQL warehouse or a Genie space -- median ' +
      'across the set. Counts calls, not bytes scanned or cost.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
  {
    id: 'error_rate',
    label: 'Error rate',
    kind: 'operational',
    unit: 'rate',
    meaning:
      'Cases that produced no answer at all: the run failed, or stopped at the identity gate. A refusal ' +
      'and a clarification are not errors and are not counted here.',
    availability: 'reported',
    blockedReason: '',
    gating: false,
  },
];

const CATALOG_BY_ID = new Map(SCORER_CATALOG.map((entry) => [entry.id, entry]));

export function scorerDefinition(id: string): ScorerDefinition | null {
  return CATALOG_BY_ID.get(id) ?? null;
}

/** The scorers that abstain, so the pane can list them under their own heading. */
export function unimplementableScorers(): ScorerDefinition[] {
  return SCORER_CATALOG.filter((entry) => entry.availability === 'unimplementable');
}
