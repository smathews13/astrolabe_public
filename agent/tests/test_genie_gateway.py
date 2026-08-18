"""Genie output held to the SQL path's standard, at the gateway.

The property under test is one sentence: a figure that reaches a reader can be
traced to a read the guard inspected. Direct SQL has satisfied it since it was
written. Genie did not, and the gap was not an oversight so much as a bargain:
Genie's prose is useful, its charts demo well, and refusing them costs something
visible, so an unattributable answer was returned with a caveat saying the
sources were incomplete.

THE CAVEAT WAS NOT A CONTROL. Genie states its findings inside the sentence, so
"the sources are incomplete" arrives attached to the number it is supposed to
qualify, and the reader keeps the number. These tests pin the reversal, and
several of them assert on the ABSENCE of a specific figure, because that is the
only way to state the requirement: the value must not be in the return path at
all, not merely flagged in it.

`test_tools.py` holds the history of each individual judgement call. This file
is about the gateway: the verdict trail it leaves, the one escape hatch it
allows, and the boundaries it must not overreach past.
"""

import dataclasses
from types import SimpleNamespace

import pytest
from databricks.sdk.service.dashboards import MessageStatus

import evidence
import failures
import tools
from evidence import EvidenceRefused, refusal_guidance
from sql_policy import SqlRefused
from tests.test_tools import ACTIVITY, PROFILES, FakeGenie, attachment, build


def refusal_of(genie: FakeGenie, question: str = "q") -> EvidenceRefused:
    with pytest.raises(SqlRefused) as raised:
        build(genie).data_genie(question)
    assert isinstance(raised.value, EvidenceRefused), (
        "an unattributable result is a GATEWAY refusal and has to carry its verdict, or the "
        "run has nothing to record and the decision exists only in a log line"
    )
    return raised.value


# ---------------------------------------------------------------------------
# The verdict trail
#
# A refusal the run cannot see is a refusal nobody can audit. The exception
# carries the verdict because there is no ToolResult on this path.
# ---------------------------------------------------------------------------


def test_a_refused_genie_result_carries_a_verdict_the_run_can_record():
    verdict = refusal_of(FakeGenie(MessageStatus.COMPLETED, sql="SELECT FROM WHERE )(")).verdict

    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE
    assert verdict.candidate.route == evidence.ROUTE_GENIE
    assert verdict.candidate.identity_mode in failures.IDENTITY_MODES
    assert verdict.candidate.validator_version, "an unversioned verdict cannot be compared later"


def test_the_recorded_verdict_does_not_carry_the_statement_that_was_refused():
    """The record is the audit trail, and an audit trail is a disclosure surface.

    A refused statement can contain the protected value it was refused FOR, so
    persisting it would write that value into Lakebase and the trace, which is
    where the refusal exists to keep it from going. The hash is what tells two
    attempts apart.
    """

    sql = f"SELECT max(email) FROM {PROFILES} WHERE )("
    record = refusal_of(FakeGenie(MessageStatus.COMPLETED, sql=sql)).verdict.as_record()

    assert "email" not in str(record), "the refused statement must not survive in the record"
    assert record["sql_sha256"], "but the attempt is still identifiable"
    assert record["terminal_code"] == failures.GENIE_UNATTRIBUTABLE, (
        "this code is terminal in its own right, so it maps to itself: the app has a message "
        "for an unattributable answer, and flattening it to NO_VALID_EVIDENCE would lose the "
        "distinction between a run that found nothing and one that found something it could "
        "not stand behind"
    )


def test_the_trail_names_every_attachment_that_was_judged_not_just_the_summary():
    """One message, several statements, and an audit that has to say which failed.

    The summary verdict can only carry one fingerprint, so on its own it reduces
    three distinct failures to "this message was unattributable". Whoever reads
    the record later is trying to find out WHICH statement the guard could not
    parse, so the trail travels with the refusal.
    """

    refusal = refusal_of(
        FakeGenie(
            MessageStatus.COMPLETED,
            attachments=[
                attachment(sql="SELECT FROM WHERE )(", text="8,413 active players."),
                attachment(sql="SELECT 1", text="Of those, 1,204 are addressable."),
                attachment(viz=SimpleNamespace(type="bar")),
            ],
        )
    )

    assert len(refusal.verdicts) == 3, "each attachment is judged, and each judgement is kept"
    assert {verdict.code for verdict in refusal.verdicts} == {failures.GENIE_UNATTRIBUTABLE}
    hashes = {verdict.candidate.sql_hash for verdict in refusal.verdicts}
    assert len(hashes) == 3, "the two statements are distinguishable, and the chart has no hash"
    assert "" in hashes, "the chart, which never had a statement to fingerprint"


def test_a_refusal_tells_the_model_what_to_do_and_what_not_to_repeat():
    """A control that only says no gets routed around by a model trying to help."""

    refusal = str(refusal_of(FakeGenie(MessageStatus.COMPLETED, sql="SELECT 1")))

    assert "ASK THIS SAME SPACE AGAIN FOR A TABLE" in refusal, (
        "not merely a hint: a table comes back with a query attachment, so this is the path "
        "from a refused chart to a charted answer, and it costs one turn"
    )
    assert "do not repeat the figures" in refusal, (
        "the model has already SEEN the prose in an earlier turn's context, so the refusal has "
        "to forbid quoting it, not merely decline to supply it again"
    )


# ---------------------------------------------------------------------------
# The re-ask, and the contradiction that used to sit on top of it
#
# The cost of refusing a chart is meant to be ONE TURN: ask the same space for a
# table, get a query attachment, attribute it, chart the accepted evidence. That
# only works if the model is told to, consistently.
# ---------------------------------------------------------------------------


def test_the_tool_asks_for_a_table_before_anything_has_been_refused():
    """The cheapest place to fix this, and the one that decides the refusal RATE.

    Every other mechanism here is recovery: something was refused and the model is
    told what to do next, which costs a turn. This sentence stops the refusal
    happening. It is in the tool description rather than the system prompt because a
    model chooses its wording while reading the tool it is about to call.
    """

    description = tools.DATA_GENIE_TOOL["function"]["description"]

    assert "ASK FOR A TABLE" in description
    assert "not a chart" in description
    assert "query behind it" in description, "the reason, so it survives a rewrite"


def test_an_attribution_refusal_is_told_to_re_ask_rather_than_to_stop():
    """The loop used to contradict the tool, and this is the fix.

    The wrapper the loop puts on every refusal said "Do NOT ask another tool the
    same question, and do not rephrase it as prose for a Genie space", which is
    right for a protected column and wrong here: the tool had just said to ask
    the same space for a table. A model handed both instructions in one message
    picks one at random, which is a poor way to run a control whose entire cost
    is one extra turn.
    """

    guidance = refusal_guidance(
        EvidenceRefused(
            evidence.Verdict(
                outcome=evidence.REFUSED,
                candidate=evidence.EvidenceCandidate(
                    tool="data_genie",
                    route=evidence.ROUTE_GENIE,
                    payload_type=evidence.PAYLOAD_VISUALIZATION,
                ),
                code=failures.GENIE_UNATTRIBUTABLE,
                reason="a chart with no query behind it",
            )
        )
    )

    assert "ASK THE SAME GENIE SPACE AGAIN" in guidance
    assert "as a TABLE" in guidance
    assert "Do NOT ask another tool the same question" not in guidance, (
        "the sentence that contradicted the remedy"
    )
    assert "can be charted afterwards" in guidance, (
        "the model should know a refused chart is recoverable, not forbidden"
    )


def test_a_protected_column_refusal_keeps_the_restriction_wording():
    """The other half, unchanged, and the reason the dispatch exists.

    A column policy refusal IS a restriction on the answer, so every route to it
    is closed and re-asking in prose is circumvention. Losing this text would
    turn the fix above into a hole in the control it sits next to.
    """

    guidance = refusal_guidance(SqlRefused("returns email", failures.COLUMN_POLICY_VIOLATION))

    assert "Do NOT ask another tool the same question" in guidance
    assert "do not rephrase it as prose for a Genie space" in guidance
    assert "ASK THE SAME GENIE SPACE AGAIN" not in guidance


def test_a_refusal_that_names_a_remedy_is_told_to_rewrite_once():
    """The third contradiction of this kind, and the one Sam paid for.

    Asked for week-over-week retention, the run was refused with "COUNT them
    instead", then handed the restriction wording, which says not to re-ask. Told
    to count and told not to try again in one message, it re-sent a near-identical
    query, was refused identically, and answered that retention could not be
    produced.

    The refusal is raised through the real guard rather than constructed here, so
    this fails if the remedy stops being set at the raise site -- which is the way
    this would rot, the dispatch being fine and nothing reaching it.
    """

    with pytest.raises(SqlRefused) as raised:
        tools.validate_sql(f"SELECT email FROM {PROFILES}", (PROFILES,))
    guidance = refusal_guidance(raised.value)

    assert "exactly ONE more attempt" in guidance
    assert "keep the identifier inside a CTE" in guidance
    assert "not the same query re-sent" in guidance
    assert "Do NOT ask another tool the same question" not in guidance, (
        "the sentence that contradicted the remedy"
    )
    # The honest answer is still the outcome when the rewrite fails too.
    assert "refused and why" in guidance
    assert "do not restate any figure from a refused attempt" in guidance


def test_the_second_remediable_refusal_is_told_to_stop_rather_than_rewrite_again():
    """The bound, which is half the fix.

    "Rewrite it" with no ceiling is a run that spends its whole tool budget being
    refused and then has nothing left to answer the part it could have answered.
    """

    with pytest.raises(SqlRefused) as raised:
        tools.validate_sql(f"SELECT email FROM {PROFILES}", (PROFILES,))
    guidance = refusal_guidance(raised.value, already_advised=True)

    assert "do NOT try a third" in guidance
    assert "exactly ONE more attempt" not in guidance
    assert "refused and why" in guidance


def test_a_cross_label_bridge_is_not_remediable_and_keeps_the_restriction_wording():
    """The line the remedy must not be on the wrong side of.

    crm_customer_ref is a restriction on the ANSWER: there is no rewrite that
    returns it, so inviting one would turn a control into a retry loop. Only a
    refusal about how the statement is WRITTEN carries a remedy.
    """

    with pytest.raises(SqlRefused) as raised:
        tools.validate_sql(
            f"SELECT count(*) AS n FROM {PROFILES} WHERE crm_customer_ref IS NOT NULL",
            (PROFILES,),
        )
    assert raised.value.remedy == ""

    guidance = refusal_guidance(raised.value)
    assert "Do NOT ask another tool the same question" in guidance
    assert "exactly ONE more attempt" not in guidance


def test_a_refusal_with_no_code_gets_the_restrictive_wording():
    """Fail closed on the guidance too.

    An unrecognised or missing code has to take the cautious branch: telling a
    model to re-ask after a refusal nobody classified is how a control gets
    talked around by its own error message.
    """

    assert "Do NOT ask another tool" in refusal_guidance(SqlRefused("something refused"))


# ---------------------------------------------------------------------------
# The one escape hatch
#
# The plan allows exactly one: a governed semantic metric, because it is
# machine-verifiable attribution rather than a promise.
# ---------------------------------------------------------------------------


def test_a_governed_metric_attributes_a_chart_that_has_no_sql():
    # ACTIVITY because the metric id has to be something the manifest declares.
    # THIS ROUTE IS UNREACHABLE IN THE RUNNING PRODUCT: the demo schema is twelve
    # plain managed tables and no metric view exists, so nothing supplies a metric
    # id and `tools.py` never passes one. Kept and tested because it is the only
    # sanctioned way to attribute a chart, so it is what a metric layer would
    # arrive into.
    gateway = build(FakeGenie(MessageStatus.COMPLETED)).gateway()

    verdict = gateway.admit_genie_visualization("data_genie", metric_ids=(ACTIVITY,))

    assert verdict.accepted
    assert verdict.sources == (ACTIVITY,)
    assert verdict.candidate.payload_type == evidence.PAYLOAD_METRIC


def test_the_same_chart_without_a_metric_is_refused():
    """The pair above and below is the whole rule: the metric does the work."""

    gateway = build(FakeGenie(MessageStatus.COMPLETED)).gateway()

    verdict = gateway.admit_genie_visualization("data_genie")

    assert not verdict.accepted
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE


# ---------------------------------------------------------------------------
# What the gateway must NOT refuse
#
# A control that fires on everything gets switched off. These are the cases
# where withholding would be wrong, and they are as load-bearing as the
# refusals: the dictionary space answers from metadata and reads nothing.
# ---------------------------------------------------------------------------


def test_a_definition_with_no_query_behind_it_is_still_admitted():
    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[attachment(text="An active player is one with a session in 30 days.")],
    )

    result = build(genie).dictionary_genie("what is an active player")

    assert "active player" in result.text
    assert result.attributed is True
    assert "incomplete" not in result.text
    assert [verdict.outcome for verdict in result.verdicts] == [evidence.ACCEPTED]


#: The exact attachment the live dictionary space returned for a field nothing
#: documents, with only the demo's catalog name moved onto this file's fictional
#: one. It parses, and it names no table, because the absence of a row is the
#: thing being reported.
LIVE_UNDOCUMENTED_FIELD_SQL = (
    "SELECT 'The field launch_campaign_sessions is not documented in the "
    "data_dictionary table.' AS message"
)
LIVE_UNDOCUMENTED_FIELD_ANSWER = (
    "The field **launch_campaign_sessions** is not documented in the data_dictionary table."
)


def test_the_dictionary_answer_that_used_to_be_thrown_away_now_reaches_the_run():
    """The reported defect, at the tool, from the live response shape.

    Every run that asked about a field the dictionary does not define lost the
    answer to it. The space said so plainly, in the text attachment; the query
    attachment beside it named no table, the figures rule dropped the message on
    that basis, and the step went out as `partial` with nothing in it. The user
    was watching a control fire on a correct answer.

    The text attachment arrives AFTER the query in the live message, which is why
    the message is read for prose before the attachments are judged.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(sql=LIVE_UNDOCUMENTED_FIELD_SQL),
            attachment(text=LIVE_UNDOCUMENTED_FIELD_ANSWER),
        ],
    )

    result = build(genie).dictionary_genie("what does launch_campaign_sessions mean")

    assert "not documented" in result.text
    assert "REFUSED" not in result.text
    assert result.attributed is True, (
        "a definition that named no table is not a missing source, and marking it as one "
        "puts an attribution warning on the honest answer"
    )
    assert [verdict.outcome for verdict in result.verdicts] == [evidence.ACCEPTED]
    assert result.verdicts[0].candidate.payload_type == evidence.PAYLOAD_DEFINITION


def test_the_same_answer_from_the_data_space_is_still_refused():
    """The pair, and the reason the fix is a distinction rather than a relaxation.

    Identical attachments, asked of the space that answers with FIGURES. A number
    a reader cannot trace to a table is the whole thing this gate exists for, so
    this one still contributes nothing and still says so.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(sql="SELECT 8413 AS active_players"),
            attachment(text="There are 8,413 active players."),
        ],
    )

    with pytest.raises(SqlRefused) as raised:
        build(genie).data_genie("how many active players")

    assert getattr(raised.value, "code", "") == failures.GENIE_UNATTRIBUTABLE
    assert "8,413" not in str(raised.value), "the figure must not survive in the refusal either"


def test_a_definition_that_read_no_table_presents_no_query_and_no_rows():
    """Admitted as prose, and not dressed up as a read that did not happen.

    The statement named nothing, so it is not the source of the definition and
    must not be shown as the query behind it. Its rows are not fetched either: a
    result set nothing can attribute is exactly what this gate declines to render,
    and the definition is in the prose regardless.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(sql=LIVE_UNDOCUMENTED_FIELD_SQL),
            attachment(text=LIVE_UNDOCUMENTED_FIELD_ANSWER),
        ],
    )

    result = build(genie).dictionary_genie("what does launch_campaign_sessions mean")

    assert result.sql == ""
    assert result.sources == []
    assert genie.result_fetches == []
    assert "Query result" not in result.text
    assert "without reading the dictionary table" in result.text, (
        "the model is told what it has, so an answer cannot call this the documented definition"
    )


def test_a_dictionary_lookup_that_did_read_the_dictionary_still_cites_it():
    """The common shape, unchanged: attribution is kept where it exists.

    The same live question, on the runs where the space searched the dictionary
    table for it. That read is real and is cited, and the rows come back as they
    always did.
    """

    sql = f"SELECT column_name, business_definition FROM {ACTIVITY} WHERE column_name = 'x'"
    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=sql,
        columns=["column_name", "business_definition"],
        rows=[["active_players", "distinct players for the label, title and date"]],
        attachments=[attachment(sql=sql, text="active_players means distinct players.")],
    )

    result = build(genie).dictionary_genie("what does active_players mean")

    assert result.sources == [ACTIVITY]
    assert result.attributed is True
    assert "distinct players" in result.text
    assert "without reading the dictionary table" not in result.text


def test_the_refusal_says_which_call_was_refused_and_why():
    """It is read by a person, not only by the model.

    This sentence is a tool stage's output, so it sits in the progress list beside
    every other call the run made. "Genie ran a query" does not say which space
    was asked, and a reader who cannot tell which call was dropped cannot tell
    whether the refusal mattered.
    """

    asked = build(FakeGenie(MessageStatus.COMPLETED, sql="SELECT 1"))
    # Titled, because the title is what a reader recognises and the id is what
    # they need to open the space. `format_genie_space` exists for exactly this.
    asked.settings = dataclasses.replace(
        asked.settings, data_genie_space_title="Player Insights Data"
    )

    with pytest.raises(SqlRefused) as raised:
        asked.data_genie("how many active players")

    refusal = str(raised.value)
    assert "the call to Genie space Player Insights Data (data)" in refusal, (
        "which call, by the name the reader knows it by, with the id they would need"
    )
    assert "names no table" in refusal, "and why, in words that do not need the code to read"


def test_an_admitted_definition_still_cannot_support_a_figure():
    """Accepted is not the same as usable as a number.

    A definition is prose about a field, so it is admitted; the run still has to
    know it is not a reading of one, or a definition mentioning a threshold of 30
    becomes a figure of 30 in an answer.
    """

    gateway = build(FakeGenie(MessageStatus.COMPLETED)).gateway()

    verdict = gateway.admit_definition("dictionary_genie", has_text=True)

    assert verdict.accepted
    assert verdict.may_support_a_figure is False


def test_a_fully_attributed_query_is_admitted_with_its_table_as_the_source():
    sql = f"SELECT count(*) AS players FROM {ACTIVITY}"
    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=sql,
        columns=["players"],
        rows=[["8413"]],
        attachments=[attachment(sql=sql, text="8,413 active players.")],
    )

    result = build(genie).data_genie("how many active players")

    assert result.sources == [ACTIVITY]
    assert result.attributed is True
    assert "8,413" in result.text, "an attributed figure is exactly what should get through"
    assert result.verdicts[0].accepted


# ---------------------------------------------------------------------------
# The boundary the reversal must not cross
#
# Refusing an unattributable RESULT is not the same as refusing a message that
# never claimed to have one, and conflating them would break the tool for
# questions it answers correctly.
# ---------------------------------------------------------------------------


def test_a_genie_space_that_returns_nothing_at_all_is_not_a_governance_refusal():
    """No attachments is an empty answer, not an unattributable one.

    Worth pinning because the two are easy to collapse into one branch, and the
    consequences differ: a refusal tells the model a control fired and to stop
    asking, which for an empty response sends it to explain a restriction that
    does not exist.
    """

    result = build(FakeGenie(MessageStatus.COMPLETED, attachments=[])).data_genie("q")

    assert result.attributed is True
    assert "Genie returned no text" in result.text


def test_a_chart_beside_an_attributed_query_does_not_sink_the_message():
    """Genie commonly returns a query AND a chart of it in one message.

    The chart has no SQL of its own, so a rule that counted it as a separate
    unattributable finding would flag every charted-and-queried answer as
    partial. What matters is whether the FIGURES can be traced, and here they
    can: the query attachment resolved.
    """

    sql = f"SELECT title_name, count(*) AS players FROM {ACTIVITY} GROUP BY title_name"
    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=sql,
        columns=["title_name", "players"],
        rows=[["VLHO", "5120"]],
        attachments=[
            attachment(sql=sql, text="VLHO leads."),
            attachment(viz=SimpleNamespace(type="bar")),
        ],
    )

    result = build(genie).data_genie("chart active players by title")

    assert result.sources == [ACTIVITY]
    assert "VLHO leads." in result.text
    assert result.attributed is False, (
        "the chart itself is still not attributable, so the answer is partial rather than "
        "complete: this is the honest reading, and the query's own figures survive"
    )
    assert "part of this answer" in result.text
