"""The SQL tools, now that the gateway is in front of them.

Parity is the point. The 600-odd tests in test_tools.py and test_agent.py assert
on what these tools return and what they refuse, and they pass unchanged with the
gateway in the path, which is the strongest statement available that the refactor
moved no line. This file adds what those cannot see: that the gateway really is in
the path rather than bypassed, and that its decisions are now RECORDED, which is
the part the rest of the workstream builds on.

The fixtures are borrowed from test_tools.py on purpose. A second fake warehouse
here would be a second definition of how the warehouse behaves, and the two would
drift in the direction of whichever file was being edited.
"""

from __future__ import annotations

import pytest

import evidence
import failures
from tests.test_tools import ACTIVITY, PROFILES, FakeWarehouse, build


def test_a_query_the_guard_passes_is_recorded_as_accepted_evidence():
    tools = build(FakeWarehouse(["title", "players"], [["IFR", "10"]]))
    result = tools.run_sql(f"SELECT title, count(*) AS players FROM {ACTIVITY} GROUP BY title")

    assert len(result.verdicts) == 1
    verdict = result.verdicts[0]
    assert verdict.outcome == evidence.ACCEPTED
    assert verdict.candidate.route == evidence.ROUTE_SQL
    assert verdict.candidate.tool == "run_sql"
    assert list(verdict.sources) == [ACTIVITY]
    # Attribution is not duplicated: the tool's own `sources` and the verdict's
    # come from one parse, so the Sources block and the record cannot disagree.
    assert result.sources == list(verdict.sources)


def test_the_returned_schema_is_recorded_so_a_figure_can_be_tied_to_a_field():
    tools = build(FakeWarehouse(["title", "players"], [["IFR", "10"]]))
    result = tools.run_sql(f"SELECT title, count(*) AS players FROM {ACTIVITY} GROUP BY title")

    assert result.verdicts[0].candidate.field_names == ("title", "players")
    assert result.verdicts[0].may_support_a_figure


def test_the_named_table_path_is_the_same_gateway_under_a_different_name():
    # Two tools, one guard. What differs is what a rejection MEANS to the model,
    # which is why both exist; the admission decision must not differ.
    tools = build(FakeWarehouse(["title"], [["IFR"]]))
    result = tools.query_named_table(f"SELECT title FROM {ACTIVITY}")
    assert result.verdicts[0].candidate.tool == "query_named_table"
    assert result.verdicts[0].outcome == evidence.ACCEPTED


def test_a_statement_refused_before_it_runs_never_reaches_the_warehouse():
    warehouse = FakeWarehouse(["email"], [["a@b.c"]])
    tools = build(warehouse)
    with pytest.raises(Exception, match="COUNT them instead"):
        tools.run_sql(f"SELECT email FROM {PROFILES}")
    assert warehouse.statements == []


def test_a_star_that_returns_identifiers_is_still_refused_after_running():
    # The half of the column defence a static parse cannot do, unchanged: the
    # gateway asks the same question of the same result schema, before any row
    # becomes text.
    warehouse = FakeWarehouse(["title", "email"], [["IFR", "a@b.c"]])
    tools = build(warehouse)
    with pytest.raises(Exception, match="Refused after running"):
        tools.run_sql(f"SELECT * FROM {PROFILES}")
    # It did run. That is the point of the second check, and the refusal is about
    # what came back rather than about what was sent.
    assert warehouse.statements


def test_the_refusal_is_still_the_guards_own_sentence():
    # The messages are the policy's own words and the model's next move depends
    # on them. One of them deliberately says COUNT rather than "aggregate",
    # because recommending an aggregate hands back the bypass.
    tools = build(FakeWarehouse(["title", "email"], [["IFR", "a@b.c"]]))
    with pytest.raises(Exception) as refused:
        tools.run_sql(f"SELECT * FROM {PROFILES}")
    assert "Name the columns you need" in str(refused.value)
    # A refusal after the statement ran carries the code for that moment. The
    # parse-time one would tell an operator the statement asked for the column.
    assert getattr(refused.value, "code", "") == failures.RESULT_COLUMN_POLICY_VIOLATION


def test_a_table_outside_the_declaration_is_refused_with_the_manifest_code():
    tools = build(FakeWarehouse(["a"], [["1"]]))
    with pytest.raises(Exception) as refused:
        tools.run_sql("SELECT count(*) FROM other_catalog.other_schema.secrets")
    assert getattr(refused.value, "code", "") == failures.ASSET_NOT_IN_MANIFEST


def test_describing_a_table_is_admitted_and_cannot_become_a_figure():
    # A column list is attributable without a statement to parse, because the
    # asset it read is named. It is not evidence for a number.
    tools = build(FakeWarehouse(["col_name", "data_type", "comment"], [["title", "string", ""]]))
    result = tools.describe_table(ACTIVITY)
    assert result.verdicts[0].accepted
    assert result.verdicts[0].candidate.route == evidence.ROUTE_METADATA
    assert not result.verdicts[0].may_support_a_figure


def test_every_verdict_carries_the_manifest_it_was_judged_against():
    tools = build(FakeWarehouse(["title"], [["IFR"]]))
    result = tools.run_sql(f"SELECT title FROM {ACTIVITY}")
    digest = evidence.manifest_digest(tools.settings.readable_tables)
    assert result.verdicts[0].candidate.manifest_digest == digest
    assert result.verdicts[0].candidate.validator_version == evidence.VALIDATOR_VERSION


def test_the_identity_the_evidence_was_produced_under_is_recorded():
    passthrough = build(FakeWarehouse(["title"], [["IFR"]]))
    assert passthrough.identity_mode() == failures.IDENTITY_SERVICE_PRINCIPAL

    tools = build(FakeWarehouse(["title"], [["IFR"]]))
    tools.user_authorized = True
    result = tools.run_sql(f"SELECT title FROM {ACTIVITY}")
    assert result.verdicts[0].candidate.identity_mode == failures.IDENTITY_SIGNED_IN_USER


def test_the_gateway_is_never_shared_between_calls():
    # One PlayerInsightTools is built per container for the passthrough path and
    # Model Serving handles requests concurrently, so a gateway cached on the
    # instance would stamp the first caller's identity onto everybody after them.
    tools = build(FakeWarehouse(["title"], [["IFR"]]))
    assert tools.gateway() is not tools.gateway()
