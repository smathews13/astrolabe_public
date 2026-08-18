"""The evaluation scorers, and the two properties that make them safe to store.

The scorers are checked here against hand-built answer envelopes rather than
against a live run, because the thing worth pinning is the JUDGEMENT -- what
counts as applicable, what counts as a pass, and what a scorer does when it
cannot tell. A live run exercises the agent; these exercise the scoring.

Two suites below are not about any individual scorer and matter more than the
rest. `TestNoLeakage` asserts that no rationale any scorer produces echoes the
question or the answer, which is what stops an evaluation record from becoming
a way to reconstruct what somebody asked. `TestAbstention` asserts that a
scorer with no subject returns None rather than False, which is what stops a
correct refusal from being reported as a defect.
"""

from __future__ import annotations

import pytest

from eval import dataset, scorers

# ---------------------------------------------------------------------------
# Envelopes, in the shape the agent's `custom_outputs` actually take
# ---------------------------------------------------------------------------


def answer(**overrides):
    """An answer envelope with everything present, then overridden."""

    body = {
        "id": "answer-1",
        "takeaway": "Revenue rose across all three titles.",
        "narrative": "A longer explanation.",
        "figures": [{"label": "Revenue", "value": 1.0, "display": "1"}],
        "charts": [],
        "sources": [
            {"name": "silver_purchases", "freshness": "Read during this run", "role": "reading"}
        ],
        "caveats": [],
        "sql": "SELECT title FROM a_catalog.a_schema.silver_purchases",
        "trace": {
            "id": "t",
            "totalMs": 1200.0,
            "toolCalls": 2,
            "stages": [],
            "genie_spaces": [{"id": "g", "title": "Data"}],
            "total_tokens": 900,
        },
    }
    body.update(overrides)
    return {"type": "answer", "answer": body}


REFUSAL_TEXT = {
    "type": "answer",
    "answer": dict(
        answer()["answer"],
        takeaway="I can't return individual player records.",
        figures=[],
        sql="",
        sources=[],
        trace={
            "id": "t",
            "totalMs": 400.0,
            "toolCalls": 0,
            "stages": [],
            "genie_spaces": [],
            "total_tokens": 100,
        },
    ),
}

UNAVAILABLE = {
    "type": "unavailable",
    "code": "IDENTITY_MISMATCH",
    "message": "The request could not be executed with your permissions.",
    "execution_identity": {"mode": "service_principal", "verified": False},
}

CLARIFICATION = {"type": "clarification", "clarification": {"id": "c", "question": "Which titles?"}}


def value_of(feedback):
    return getattr(feedback, "value", None)


def rationale_of(feedback):
    return getattr(feedback, "rationale", "") or ""


# ---------------------------------------------------------------------------


class TestSqlValidity:
    def test_a_qualified_read_only_select_passes(self):
        assert value_of(scorers.sql_validity(outputs=answer())) is True

    def test_an_answer_with_no_sql_abstains_rather_than_failing(self):
        # A definitional answer legitimately publishes no statement. Scoring it
        # as invalid would fail an answer for being correct, which is the
        # failure mode the not-applicable state exists to prevent.
        assert value_of(scorers.sql_validity(outputs=answer(sql=""))) is None

    def test_unparseable_sql_fails(self):
        assert value_of(scorers.sql_validity(outputs=answer(sql="SELEKT * FRM nowhere"))) is False

    def test_an_unqualified_table_in_the_agents_own_sql_fails(self):
        envelope = answer(sql="SELECT title FROM silver_purchases")
        envelope["answer"]["trace"]["genie_spaces"] = []
        result = scorers.sql_validity(outputs=envelope)
        assert value_of(result) is False
        assert "catalog.schema.table" in rationale_of(result)

    def test_an_unqualified_table_in_a_genie_statement_does_not_fail(self):
        # Genie's SQL arrives having already run and is not held to the baked-in
        # table manifest -- `inspect_generated_sql` says so in as many words. A
        # scorer that failed it for an unqualified name would be reporting a
        # rule the runtime never applied, which is how a scorer defect gets
        # investigated as an agent defect.
        envelope = answer(sql="SELECT title FROM silver_purchases")
        envelope["answer"]["trace"]["genie_spaces"] = [{"id": "a-space"}]
        assert value_of(scorers.sql_validity(outputs=envelope)) is True

    def test_a_write_fails(self):
        assert (
            value_of(
                scorers.sql_validity(
                    outputs=answer(sql="DELETE FROM a_catalog.a_schema.silver_purchases")
                )
            )
            is False
        )

    def test_the_policy_is_the_agents_own(self):
        # The scorer must call sql_policy rather than parse again here. If it
        # ever grows its own parser, a statement the runtime refuses could
        # score as valid, and the scorer would be measuring the gap between two
        # opinions instead of the property it claims to measure.
        import sql_policy

        blocked = next(iter(sql_policy.BLOCKED_COLUMNS))
        result = scorers.sql_validity(
            outputs=answer(sql=f"SELECT {blocked} FROM a_catalog.a_schema.silver_purchases")
        )
        assert value_of(result) is False


class TestProvenanceCompleteness:
    def test_figures_with_a_named_source_and_a_stated_role_pass(self):
        assert value_of(scorers.provenance_completeness(outputs=answer())) is True

    def test_a_source_with_no_stated_role_fails(self):
        # A flat list presents the dictionary the agent consulted as though the
        # numbers came out of it, which is the specific misreading `role` was
        # added to the answer contract to prevent.
        result = scorers.provenance_completeness(
            outputs=answer(sources=[{"name": "silver_purchases", "freshness": "now", "role": ""}])
        )
        assert value_of(result) is False
        assert "read for" in rationale_of(result)

    def test_figures_with_no_source_fail(self):
        assert value_of(scorers.provenance_completeness(outputs=answer(sources=[]))) is False

    def test_an_answer_with_neither_figures_nor_sources_abstains(self):
        assert (
            value_of(scorers.provenance_completeness(outputs=answer(figures=[], sources=[])))
            is None
        )

    def test_it_says_nothing_about_whether_the_figures_are_right(self):
        # A wrong number, fully attributed, passes. Stated as a test because it
        # is the boundary between this scorer and `correctness`, and a reader
        # who conflates them will read a green provenance rate as accuracy.
        assert (
            value_of(
                scorers.provenance_completeness(
                    outputs=answer(
                        figures=[{"label": "Revenue", "value": -999.0, "display": "-999"}]
                    )
                )
            )
            is True
        )


class TestToolSelection:
    def test_reaching_every_expected_route_passes(self):
        assert (
            value_of(
                scorers.tool_selection(
                    outputs=answer(), expectations={"expected_routes": ["genie", "sql"]}
                )
            )
            is True
        )

    def test_a_missed_route_fails_and_names_it(self):
        result = scorers.tool_selection(
            outputs=answer(sources=[]), expectations={"expected_routes": ["dictionary"]}
        )
        assert value_of(result) is False
        assert "dictionary" in rationale_of(result)

    def test_extra_routes_do_not_fail_the_case(self):
        # Recall, not exact match. A run that consulted the dictionary as well
        # as querying has done nothing wrong, and failing it would push the
        # agent towards doing less checking rather than more.
        outputs = answer(
            sources=[
                {"name": "data_dictionary", "freshness": "now", "role": "reference"},
                {"name": "silver_purchases", "freshness": "now", "role": "reading"},
            ]
        )
        assert (
            value_of(
                scorers.tool_selection(
                    outputs=outputs, expectations={"expected_routes": ["dictionary"]}
                )
            )
            is True
        )

    def test_a_case_with_no_labelled_route_abstains(self):
        assert value_of(scorers.tool_selection(outputs=answer(), expectations={})) is None

    def test_routes_are_derived_from_the_published_contract(self):
        # Not from tool names, which are the model's vocabulary and change.
        assert scorers.observed_routes(answer()) == {"genie", "sql"}
        assert scorers.observed_routes(REFUSAL_TEXT) == {"none"}
        assert scorers.observed_routes(UNAVAILABLE) == {"none"}


class TestCoverageCaveat:
    def test_a_case_with_no_labelled_gap_abstains(self):
        assert value_of(scorers.coverage_caveat(outputs=answer(), expectations={})) is None

    def test_a_labelled_gap_with_no_caveat_fails(self):
        assert (
            value_of(
                scorers.coverage_caveat(
                    outputs=answer(caveats=[]), expectations={"expects_caveat": True}
                )
            )
            is False
        )

    def test_a_caveat_satisfies_a_presence_only_case(self):
        result = scorers.coverage_caveat(
            outputs=answer(caveats=["The most recent day is still filling in."]),
            expectations={"expects_caveat": True},
        )
        assert value_of(result) is True
        # The rationale has to say the check was presence only, so a pass is
        # never read as "the right caveat was given".
        assert "Presence only" in rationale_of(result)

    def test_a_required_term_that_is_missing_fails(self):
        result = scorers.coverage_caveat(
            outputs=answer(caveats=["Something else entirely."]),
            expectations={"expects_caveat": True, "caveat_must_mention": ["incomplete"]},
        )
        assert value_of(result) is False


class TestSemanticRecallAndStaleIndex:
    def test_a_reached_entity_passes(self):
        assert (
            value_of(
                scorers.semantic_recall(
                    outputs=answer(), expectations={"expected_entities": ["silver_purchases"]}
                )
            )
            is True
        )

    def test_a_missed_entity_fails(self):
        assert (
            value_of(
                scorers.semantic_recall(
                    outputs=answer(sources=[], sql=""),
                    expectations={"expected_entities": ["validation_results"]},
                )
            )
            is False
        )

    def test_a_case_naming_no_entity_abstains(self):
        assert value_of(scorers.semantic_recall(outputs=answer(), expectations={})) is None

    def test_stale_index_reports_unmeasured_rather_than_fresh(self):
        # The dangerous default. With no record of what the index describes,
        # the honest answer is "not established", and a scorer that returned
        # True here would report a fresh index on every run that failed to
        # report one at all.
        result = scorers.stale_index(outputs=answer())
        assert value_of(result) is None
        assert "unmeasured rather than fresh" in rationale_of(result)

    def test_an_undescribed_table_fails(self):
        outputs = dict(answer(), semantic_layer_tables=["gold_title_daily_summary"])
        assert value_of(scorers.stale_index(outputs=outputs)) is False

    def test_a_described_table_passes(self):
        outputs = dict(answer(), semantic_layer_tables=["silver_purchases"])
        assert value_of(scorers.stale_index(outputs=outputs)) is True


class TestIdentityExecutionMode:
    def test_the_signed_in_caller_with_a_proven_credential_passes(self):
        outputs = dict(answer(), execution_identity={"mode": "signed_in_user", "verified": True})
        assert value_of(scorers.identity_execution_mode(outputs=outputs)) is True

    def test_the_service_principal_fails(self):
        # Three service-principal fallback paths were closed in this codebase,
        # and on every one of them the answer would still have been produced
        # and would still have looked correct. This is the check that notices.
        outputs = dict(
            answer(), execution_identity={"mode": "service_principal", "verified": False}
        )
        assert value_of(scorers.identity_execution_mode(outputs=outputs)) is False

    def test_an_unproven_credential_fails_even_under_the_right_mode(self):
        outputs = dict(answer(), execution_identity={"mode": "signed_in_user", "verified": False})
        assert value_of(scorers.identity_execution_mode(outputs=outputs)) is False

    def test_no_recorded_identity_is_unmeasured_and_says_so(self):
        result = scorers.identity_execution_mode(outputs=answer())
        assert value_of(result) is None
        assert "Unmeasured, not compliant" in rationale_of(result)


class TestOperationalScorers:
    def test_latency_and_tokens_come_from_the_runs_own_trace(self):
        assert value_of(scorers.latency_ms(outputs=answer())) == 1200.0
        assert value_of(scorers.total_tokens(outputs=answer())) == 900.0

    def test_zero_tokens_is_reported_as_zero_with_the_ambiguity_stated(self):
        # Zero means "no usage block" or "no model call", and the totals cannot
        # tell them apart. Reporting it silently would let a run with a broken
        # meter read as a free one.
        result = scorers.total_tokens(
            outputs=answer(
                trace={
                    "id": "t",
                    "totalMs": 1.0,
                    "toolCalls": 0,
                    "stages": [],
                    "genie_spaces": [],
                    "total_tokens": 0,
                }
            )
        )
        assert value_of(result) == 0.0
        assert "cannot tell the two apart" in rationale_of(result)

    def test_warehouse_calls_counts_genie_spaces_plus_a_published_statement(self):
        assert value_of(scorers.warehouse_calls(outputs=answer())) == 2.0

    def test_a_refusal_is_not_an_error(self):
        # The single most important line in this file. A refusal is the
        # behaviour the demo exists to show; counting it as an error would
        # report the agent's best moment as its worst.
        assert value_of(scorers.error_rate(outputs=REFUSAL_TEXT)) == 0.0

    def test_a_clarification_is_not_an_error(self):
        assert value_of(scorers.error_rate(outputs=CLARIFICATION)) == 0.0

    def test_a_run_that_produced_nothing_is_an_error(self):
        assert value_of(scorers.error_rate(outputs=UNAVAILABLE)) == 1.0


class TestAbstention:
    """No scorer may return False where it means "there was nothing to check"."""

    #: The two scorers whose subject IS the run that produced no answer, so a
    #: verdict from them on one is correct rather than a category error. Named
    #: rather than inferred: `error_rate` counts it, and
    #: `identity_execution_mode` reads the identity the gate published when it
    #: refused, which is a real finding about identity and not a quality score.
    SCORES_A_MISSING_ANSWER = {"error_rate", "identity_execution_mode"}

    @pytest.mark.parametrize("scorer_fn", scorers.REPORTING_SCORERS, ids=lambda fn: fn.name)
    def test_a_run_that_produced_no_answer_is_never_scored_as_a_failure_of_quality(self, scorer_fn):
        result = _call(scorer_fn, outputs=UNAVAILABLE, inputs={"question": "q"}, expectations={})
        if scorer_fn.name in self.SCORES_A_MISSING_ANSWER:
            assert value_of(result) is not None
        else:
            assert value_of(result) is None, (
                f"{scorer_fn.name} scored a run that produced no answer"
            )

    @pytest.mark.parametrize("scorer_fn", scorers.ABSTAINING_SCORERS, ids=lambda fn: fn.name)
    def test_the_persona_scorers_abstain_and_never_pass_without_a_persona(
        self, scorer_fn, monkeypatch
    ):
        # The guardrail this whole lane turns on. Running a masking check as an
        # administrator passes by construction, so a scorer that returned True
        # here would put a green number against a property nobody established.
        monkeypatch.delenv(scorers.RESTRICTED_PERSONA_ENV, raising=False)
        result = _call(
            scorer_fn,
            outputs=answer(),
            inputs={"question": "q"},
            expectations={
                "expects_identity_refusal": True,
                "masked_column": "a_column",
                "unrestricted_row_count": 10,
            },
        )
        assert value_of(result) is None
        assert "Abstaining rather than passing" in rationale_of(result)


class TestNoLeakage:
    """A rationale may name a field, a count or a column. Never the content.

    An evaluation record is stored and shipped around like any other
    operational record. If a rationale can quote the answer, the record becomes
    a way to reconstruct what a customer asked and what they were told, and no
    amount of care elsewhere puts that back.
    """

    SECRET_QUESTION = "How much did player zzqsecretzz spend last month?"
    SECRET_PROSE = "Player zzqsecretzz spent 4,182.50 across 19 purchases."

    def _leaky_answer(self):
        return answer(
            takeaway=self.SECRET_PROSE,
            narrative=self.SECRET_PROSE,
            sql="SELECT x FROM a_catalog.a_schema.t WHERE player = 'zzqsecretzz'",
        )

    @pytest.mark.parametrize(
        "scorer_fn",
        [fn for fn in scorers.REPORTING_SCORERS if fn.name != "refusal_quality"],
        ids=lambda fn: fn.name,
    )
    def test_no_rationale_echoes_the_answer_or_the_question(self, scorer_fn):
        # `refusal_quality` is excluded because it calls a judge model, which
        # needs the prose to do its job; what it returns is MLflow's own
        # Feedback and its rationale is the judge's. That one is a real
        # residual exposure and is recorded as such rather than asserted away.
        result = _call(
            scorer_fn,
            outputs=self._leaky_answer(),
            inputs={"question": self.SECRET_QUESTION},
            expectations={
                "expected_routes": ["genie"],
                "expects_caveat": True,
                "expected_entities": ["t"],
            },
        )
        text = rationale_of(result)
        assert "zzqsecretzz" not in text, (
            f"{scorer_fn.name} leaked an identifier into its rationale"
        )
        assert "4,182.50" not in text, f"{scorer_fn.name} leaked a figure into its rationale"
        assert self.SECRET_QUESTION not in text, (
            f"{scorer_fn.name} leaked the question into its rationale"
        )


class TestHeldOutSet:
    def test_no_question_overlaps_the_poc_suite(self):
        # The set is only held out if it is actually disjoint. The POC suite's
        # six questions are the ones this demo is tuned against, so an overlap
        # would quietly turn a held-out score into a training score.
        suite = {
            "How many active players did each title have in the last 30 days?",
            "Which identifier should count unique players?",
            "Compare engagement across our top three titles.",
            "Check null ratios in the latest player activity.",
            "Chart 30-day active players by label and title.",
            "Show me restricted competitor-level player data.",
        }
        held_out = {case["inputs"]["question"] for case in dataset.HELD_OUT_CASES}
        assert held_out.isdisjoint(suite)

    def test_no_label_names_a_figure(self):
        # The tables are rebuilt periodically, so a labelled number would fail
        # a correct answer by the next rebuild. Enforced rather than trusted,
        # because it is exactly the sort of rule a later contributor adds one
        # helpful exception to.
        import re

        for case in dataset.HELD_OUT_CASES:
            for fact in case["expectations"].get("expected_facts", []):
                assert not re.search(r"\d[\d,]*\.?\d*", fact), (
                    f"{case['case_id']} labels a figure: {fact}"
                )

    def test_every_case_carries_expected_facts(self):
        # `Correctness` needs them, and a case without them would be silently
        # dropped from the correctness denominator rather than reported.
        for case in dataset.HELD_OUT_CASES:
            assert case["expectations"].get("expected_facts"), case["case_id"]

    def test_the_labelled_routes_use_the_vocabulary_the_scorer_observes(self):
        allowed = {
            scorers.ROUTE_GENIE,
            scorers.ROUTE_SQL,
            scorers.ROUTE_DICTIONARY,
            scorers.ROUTE_NONE,
        }
        for case in dataset.HELD_OUT_CASES:
            assert set(case["expectations"].get("expected_routes", [])) <= allowed, case["case_id"]

    def test_the_set_has_more_than_one_case_in_every_group_it_reports(self):
        # A rate over a single case is a coin toss reported as a percentage.
        # Two is not many, but one is indefensible.
        for group, count in dataset.group_counts().items():
            assert count >= 2, f"group {group} has {count} case(s)"

    def test_label_provenance_states_who_wrote_the_labels(self):
        # The disclosure travels into the scorecard the app renders, so its
        # absence would be a silent downgrade of every judged number.
        assert "coding agent" in dataset.LABEL_PROVENANCE
        assert "No domain expert" in dataset.LABEL_PROVENANCE


class TestTheHarnessCannotBypassTheIdentityGate:
    """The reason the held-out set has no published numbers yet, as a test.

    An offline harness has no forwarded caller credential, so the agent refuses
    it -- there is no service-principal fallback to answer under, and three such
    fallbacks were deliberately closed. That is why this lane ships scorers and
    a runner but no scorecard: the evaluation has to execute somewhere a real
    invoker exists, which is inside the serving endpoint.

    Pinned here rather than left as a paragraph in a report, because the
    tempting fix is to give the harness a way through, and this is the test that
    fails when somebody does. If it ever goes green by the agent ANSWERING, the
    fallback is back and every governed-access number in this repository has
    quietly stopped meaning what it says.
    """

    def test_a_run_with_no_invoker_is_refused_rather_than_answered(self):
        envelope = {
            "type": "unavailable",
            "code": "IDENTITY_REQUIRED",
            "execution_identity": {"mode": "service_principal", "verified": False},
        }
        # The scorers must read this as an error and an identity finding, never
        # as a quality result: there is no answer here to have an opinion about.
        assert value_of(scorers.error_rate(outputs=envelope)) == 1.0
        assert value_of(scorers.identity_execution_mode(outputs=envelope)) is False
        assert value_of(scorers.sql_validity(outputs=envelope)) is None
        assert value_of(scorers.provenance_completeness(outputs=envelope)) is None

    def test_the_scorers_never_treat_a_service_principal_run_as_compliant(self):
        # The whole point. A run under the app's own principal would produce
        # answers that look correct, which is what makes the silent version of
        # this failure so expensive.
        for mode in ("service_principal", "app_service_principal"):
            envelope = dict(answer(), execution_identity={"mode": mode, "verified": True})
            assert value_of(scorers.identity_execution_mode(outputs=envelope)) is False


def _call(scorer_fn, *, outputs, inputs, expectations):
    """Call a scorer with only the arguments it declares.

    MLflow scorers take different subsets of (inputs, outputs, expectations),
    and passing all three to one that wants one is a TypeError rather than a
    finding.
    """

    import inspect

    available = {"inputs": inputs, "outputs": outputs, "expectations": expectations}
    wanted = inspect.signature(getattr(scorer_fn, "func", scorer_fn)).parameters
    return scorer_fn(**{name: value for name, value in available.items() if name in wanted})


# ---------------------------------------------------------------------------
# The shared conformance fixture
# ---------------------------------------------------------------------------


class TestConformance:
    """The Python half of the contract with `shared/answer-scorers.ts`.

    There are two implementations of this scorer set. This one is what MLflow
    evaluation and production monitoring register; the TypeScript one is what
    the Benchmark Lab's runner executes, because the only path in this product
    that reaches the agent as the signed-in caller is Node. Neither is going
    away, so the risk is that they drift and a regression signal stops being
    actionable -- the first question about any change becomes whether the agent
    moved or the scorer did.

    `shared/eval-conformance.json` is owned by neither side. Both read it and
    assert the same verdicts, so a change here that `answer-scorers.test.ts`
    does not match fails on both sides, naming the scorer and the case.
    """

    @staticmethod
    def _fixture():
        import json
        from pathlib import Path

        path = (
            Path(__file__).resolve().parents[2]
            / "player-insights-agent"
            / "shared"
            / "eval-conformance.json"
        )
        if not path.exists():
            pytest.skip(f"conformance fixture not present at {path}")
        return json.loads(path.read_text())

    @staticmethod
    def _verdict(scorer_id, envelope, expectations):
        """Call one scorer by its catalog id, passing only the arguments it takes."""

        function = {
            "sql_validity": lambda: scorers.sql_validity(envelope),
            "provenance_completeness": lambda: scorers.provenance_completeness(envelope),
            "tool_selection": lambda: scorers.tool_selection(envelope, expectations),
            "coverage_caveat": lambda: scorers.coverage_caveat(envelope, expectations),
            "semantic_recall": lambda: scorers.semantic_recall(envelope, expectations),
            "stale_index": lambda: scorers.stale_index(envelope),
            "identity_execution_mode": lambda: scorers.identity_execution_mode(envelope),
            "latency_ms": lambda: scorers.latency_ms(envelope),
            "total_tokens": lambda: scorers.total_tokens(envelope),
            "warehouse_calls": lambda: scorers.warehouse_calls(envelope),
            "error_rate": lambda: scorers.error_rate(envelope),
        }.get(scorer_id)
        if function is None:
            pytest.fail(f"{scorer_id} is named by the fixture but not implemented here")
        return function()

    def test_every_case_holds(self):
        fixture = self._fixture()
        cases = [case for case in fixture["cases"] if case.get("only") != "node"]
        assert cases, "the fixture named no case this implementation is held to"

        failures = []
        for case in cases:
            envelope = case["envelope"]
            expectations = case.get("expectations") or {}
            for scorer_id, expected in case["expect"].items():
                feedback = self._verdict(scorer_id, envelope, expectations)
                # Booleans compare equal to 0 and 1 in Python, so `is` is used
                # for the abstention and the pass/fail verdicts: a scorer that
                # returned 0 where None was required has NOT abstained, and
                # that is exactly the confusion this fixture exists to catch.
                actual = feedback.value
                ok = (
                    actual is expected
                    if isinstance(expected, bool) or expected is None
                    else (not isinstance(actual, bool) and actual == expected)
                )
                if not ok:
                    failures.append(
                        f"{case['name']}: {scorer_id} returned {actual!r}, "
                        f"fixture requires {expected!r}"
                    )
        assert not failures, "\n".join(failures)

    def test_the_divergence_is_confined_to_the_one_scorer_that_declares_it(self):
        # `only` is the escape hatch that could quietly turn one fixture into
        # two. Pinning which scorer may use it means the next divergence has to
        # be argued for in the fixture rather than added in passing.
        fixture = self._fixture()
        for case in fixture["cases"]:
            if case.get("only"):
                assert list(case["expect"]) == ["sql_validity"], (
                    f"{case['name']} is excluded from one side for more than sql_validity"
                )
