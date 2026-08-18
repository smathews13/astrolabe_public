"""What the gateway does when the release opens the valve, and what it still will not do.

The valve turns a refusal back into a caveat. It does NOT turn an untraceable
figure into an attributed one, and the difference is most of this file: a waived
result may be shown, cites nothing, cannot support a figure, is recorded as
waived, and puts a disclosure on the answer. Every one of those has to hold, or
"permissive" quietly becomes "pretends it was fine".

The strict default is covered by `test_genie_gateway.py` and `test_tools.py`.
Here it appears only as the control case, because a flag whose off state is not
tested next to its on state is a flag that will one day be on by accident.
"""

from types import SimpleNamespace

import pytest
from databricks.sdk.service.dashboards import MessageStatus

import evidence
import failures
from evidence import EvidenceCandidate, EvidenceGateway, Verdict
from sql_policy import SqlRefused
from tests.test_agent import Call, FakeTools, ScriptedLlm, ask
from tests.test_agent import build as build_run
from tests.test_tools import ACTIVITY, PROFILES, FakeGenie, attachment, build
from tools import ToolResult

CHART = attachment(text="8,413 active players.", viz=SimpleNamespace(type="bar"))


def permissive(genie: FakeGenie):
    """The tools with the valve open, built the way the agent builds them."""

    tools = build(genie)
    tools.allow_unattributed_figures = True
    return tools


# ---------------------------------------------------------------------------
# The valve, open
# ---------------------------------------------------------------------------


def test_a_chart_with_no_query_is_answered_instead_of_refused():
    result = permissive(FakeGenie(MessageStatus.COMPLETED, attachments=[CHART])).data_genie("q")

    assert "8,413" in result.text, "the answer a customer was waiting for"
    assert result.attributed is False, "and it is still not attributed"
    assert result.sources == [], "because nothing became traceable by being permitted"


def test_unparseable_sql_is_answered_instead_of_refused():
    genie = FakeGenie(MessageStatus.COMPLETED, sql="SELECT FROM WHERE )(")

    result = permissive(genie).data_genie("q")

    assert "8,413" in result.text
    assert result.attributed is False
    assert result.sources == []


def test_the_same_two_cases_are_refused_with_the_valve_shut():
    """The control. Default strict, and the default is what almost every release gets."""

    for genie in (
        FakeGenie(MessageStatus.COMPLETED, attachments=[CHART]),
        FakeGenie(MessageStatus.COMPLETED, sql="SELECT FROM WHERE )("),
    ):
        with pytest.raises(SqlRefused):
            build(genie).data_genie("q")


# ---------------------------------------------------------------------------
# What a waiver is not
# ---------------------------------------------------------------------------


def test_a_waived_verdict_is_accepted_and_still_marked_waived():
    gateway = EvidenceGateway([ACTIVITY], allow_unattributed_figures=True)

    verdict = gateway.admit_genie_visualization("data_genie")

    assert verdict.accepted is True, "the release said this may be used"
    assert verdict.waived is True, "and the record says it was not earned"
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE, "the finding is unchanged"
    assert verdict.sources == ()


def test_a_waived_verdict_cannot_support_a_figure():
    """The subtle one, and the reason `waived` is a field rather than a log line.

    A waived verdict looks accepted in every other respect, so anything asking
    "may a number be traced to this" would get yes and be wrong. The waiver
    permitted the figures to be SHOWN. It did not make them attributable.
    """

    gateway = EvidenceGateway([ACTIVITY], allow_unattributed_figures=True)

    assert gateway.admit_genie_visualization("data_genie").may_support_a_figure is False
    assert gateway.admit_genie_query("data_genie", "SELECT FROM )(").may_support_a_figure is False


def test_an_ordinary_accepted_verdict_is_not_marked_waived():
    """Or the disclosure fires on every answer and stops meaning anything."""

    gateway = EvidenceGateway([ACTIVITY], allow_unattributed_figures=True)

    verdict = gateway.admit_genie_query("data_genie", f"SELECT count(*) FROM {ACTIVITY}")

    assert verdict.accepted is True
    assert verdict.waived is False
    assert verdict.sources == (ACTIVITY,)
    assert verdict.may_support_a_figure is True


def test_the_waiver_is_in_the_record_so_a_permissive_run_is_auditable():
    gateway = EvidenceGateway([ACTIVITY], allow_unattributed_figures=True)

    record = gateway.admit_genie_visualization("data_genie").as_record()

    assert record["waived"] is True
    assert record["outcome"] == evidence.ACCEPTED
    assert record["code"] == failures.GENIE_UNATTRIBUTABLE, (
        "an auditor looking for untraceable figures searches on the code, and an accepted "
        "verdict with no code would hide exactly the runs they are looking for"
    )


def test_the_record_still_carries_no_statement_text():
    """The waiver relaxes attribution, not the rule about what gets persisted."""

    gateway = EvidenceGateway([PROFILES], allow_unattributed_figures=True)

    record = gateway.admit_genie_query(
        "data_genie", "SELECT max(email) FROM x WHERE )("
    ).as_record()

    assert "email" not in str(record)
    assert record["sql_sha256"], "identifiable without being quoted"


# ---------------------------------------------------------------------------
# The column policy is NOT part of the valve
#
# The most important boundary here. This flag is about attribution, and a
# protected value is a different question that it must not answer.
# ---------------------------------------------------------------------------


def test_a_protected_column_is_still_refused_with_the_valve_open():
    """The valve relaxes ATTRIBUTION. It must not relax confidentiality.

    Conflating them would be easy and catastrophic: both arrive as a refusal from
    the same gateway on the same path, and somebody opening a flag to keep charts
    working in a demo would silently also permit a query that returns email
    addresses.
    """

    sql = f"SELECT max(email) FROM {PROFILES}"
    genie = FakeGenie(MessageStatus.COMPLETED, sql=sql)

    with pytest.raises(SqlRefused, match="email"):
        permissive(genie).data_genie("give me the highest email address")


def test_a_starred_result_whose_schema_names_a_protected_column_is_still_refused():
    """The post-execution half of the same boundary, which the valve also leaves alone."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT * FROM {PROFILES} LIMIT 10",
        columns=["player_id", "email", "country"],
        rows=[["p1", "player.00011999@example.test", "US"]],
    )

    with pytest.raises(SqlRefused, match="email"):
        permissive(genie).data_genie("show me the player table")


# ---------------------------------------------------------------------------
# What the model is told
# ---------------------------------------------------------------------------


def test_the_model_is_told_the_figures_are_shown_but_untraceable():
    result = permissive(FakeGenie(MessageStatus.COMPLETED, attachments=[CHART])).data_genie("q")

    assert "sources are incomplete" in result.text
    assert "still shown above" in result.text, (
        "the strict wording says the parts were WITHHELD, which is false here and invites the "
        "model to apologise for a gap the reader can see is not there"
    )
    assert "indicative" in result.text
    assert "withheld" not in result.text


def test_a_wholly_unattributed_answer_does_not_call_itself_partial():
    """Wording, and the kind that matters: "part of this answer" is a claim.

    With one chart and nothing else, no part of it resolved, and saying part did
    implies there is a traceable half a reader could go and check.
    """

    result = permissive(FakeGenie(MessageStatus.COMPLETED, attachments=[CHART])).data_genie("q")

    assert "the tables behind this answer could not be determined" in result.text
    assert "part of this answer" not in result.text


def test_the_answer_discloses_the_waiver_to_the_reader():
    """The disclosure that reaches the person at risk.

    Checked at the loop level because the two boot lines are read by whoever
    deployed the release, and the reader of an answer has no way to know a setting
    was flipped weeks ago on their behalf. Marked, so the app lifts it into the
    panel readers actually see.
    """

    waived = Verdict(
        outcome=evidence.ACCEPTED,
        candidate=EvidenceCandidate(
            tool="data_genie",
            route=evidence.ROUTE_GENIE,
            payload_type=evidence.PAYLOAD_VISUALIZATION,
        ),
        code=failures.GENIE_UNATTRIBUTABLE,
        reason="a chart with no query behind it",
        waived=True,
    )
    tools = FakeTools(
        data_genie=ToolResult(text="8,413 active players.", attributed=False, verdicts=(waived,))
    )
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "chart active players"})],
        "8,413 active players.",
    )

    caveats = ask(build_run(llm, tools)).custom_outputs["answer"]["caveats"]

    waiver = next(
        caveat for caveat in caveats if "could not be traced to a governed read" in caveat
    )
    assert "degraded" in waiver
    assert "indicative" in waiver


def test_an_ordinary_run_carries_no_waiver_caveat():
    """Conditioned on a waiver being USED, not on the flag being on.

    A permissive release still answers most questions from attributable evidence,
    and a caveat on those would be false and would train readers to skip the one
    time it is true.
    """

    tools = FakeTools(
        run_sql=ToolResult(
            text="label | players\nNorthwind | 8413",
            sql=f"SELECT label, count(*) FROM {ACTIVITY} GROUP BY label",
            sources=[ACTIVITY],
        )
    )
    llm = ScriptedLlm(
        [Call("run_sql", {"sql": f"SELECT label, count(*) FROM {ACTIVITY} GROUP BY label"})],
        "8,413 active players for Northwind.",
    )

    caveats = ask(build_run(llm, tools)).custom_outputs["answer"]["caveats"]

    assert not any("could not be traced to a governed read" in caveat for caveat in caveats)


def test_a_partly_attributed_answer_still_says_part():
    sql = f"SELECT count(*) FROM {ACTIVITY}"
    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=sql,
        attachments=[
            attachment(sql=sql, text="8,413 active players."),
            attachment(sql="", text="Of those, 1,204 are email-addressable."),
        ],
    )

    result = permissive(genie).data_genie("q")

    assert "part of this answer" in result.text
    assert result.sources == [ACTIVITY]
    assert "1,204" in result.text, "the waived half is shown rather than dropped"
    assert result.attributed is False
