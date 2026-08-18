"""Giving up on a dead end, and telling the truth about having done so.

The behaviour under test is a trade: a run stops spending its budget re-issuing
a call that cannot work, and in exchange it has to say clearly that it stopped,
in words a reader can act on. Both halves are asserted here, because a brake
that saved budget and then reported "the budget was spent" would be worse than
no brake at all -- the reader retries, and the retry fails the same way.
"""

from tool_repetition import MAX_IDENTICAL_FAILURES, RepeatedFailures, signature

MISSING_COLUMN = (
    "RuntimeError: [UNRESOLVED_COLUMN.WITH_SUGGESTION] A column with name "
    "`crm_customer_ref` cannot be resolved."
)

# The same dead end reached by a DIFFERENT statement. This is the case the whole
# module exists for, and the one a key built from the arguments would miss.
SAME_END_OTHER_SQL = (
    "RuntimeError: [UNRESOLVED_COLUMN.WITH_SUGGESTION] A column with name "
    "`crm_customer_ref` cannot be resolved. Did you mean `player_id`?"
)

MISSING_TABLE = "RuntimeError: [TABLE_OR_VIEW_NOT_FOUND] The table `gold_nothing` cannot be found."


# ---------------------------------------------------------------------------
# What counts as the same failure
# ---------------------------------------------------------------------------


def test_two_different_statements_that_die_on_the_same_column_are_one_dead_end():
    assert signature(MISSING_COLUMN) == signature(SAME_END_OTHER_SQL)


def test_two_failures_on_different_objects_stay_apart():
    """Over-collapsing would brake a tool that had not repeated itself at all."""

    assert signature(MISSING_COLUMN) != signature(MISSING_TABLE)


def test_the_loops_own_envelope_is_stripped_before_the_key_is_taken():
    """The same warehouse error reaches this wrapped in more than one way."""

    assert signature(f"ERROR: tool 'run_sql' failed: {MISSING_COLUMN}") == signature(MISSING_COLUMN)


def test_a_message_with_no_error_code_still_gets_a_stable_key():
    assert signature("the space did not answer") == signature("The space did not answer.")
    assert signature("the space did not answer") != signature("the warehouse was busy")


# ---------------------------------------------------------------------------
# When the run gives up
# ---------------------------------------------------------------------------


def test_one_failure_is_not_enough_to_give_up():
    """A first failure is information the model did not have. Acting on it is
    the recovery the loop is built around, so it must not be pre-empted."""

    ledger = RepeatedFailures()

    assert ledger.record("run_sql", MISSING_COLUMN) is False
    assert ledger.abandoned == []
    assert ledger.skip_batch("run_sql") == ""


def test_the_second_identical_failure_abandons_that_line_of_attack():
    ledger = RepeatedFailures()

    ledger.record("run_sql", MISSING_COLUMN)

    assert ledger.record("run_sql", SAME_END_OTHER_SQL) is True
    assert ledger.gave_up_on("run_sql", MISSING_COLUMN)
    assert MAX_IDENTICAL_FAILURES == 2


def test_giving_up_is_announced_exactly_once():
    """So a caller can act on the decision without re-announcing it every call."""

    ledger = RepeatedFailures()
    results = [ledger.record("run_sql", MISSING_COLUMN) for _ in range(4)]

    assert results == [False, True, False, False]


def test_a_tool_that_failed_twice_does_not_brake_a_different_tool():
    ledger = RepeatedFailures()

    ledger.record("run_sql", MISSING_COLUMN)
    ledger.record("run_sql", MISSING_COLUMN)

    assert ledger.skip_batch("data_genie") == ""


def test_two_unrelated_failures_from_one_tool_do_not_brake_it():
    """The rule is "the same way twice", not "twice"."""

    ledger = RepeatedFailures()

    ledger.record("run_sql", MISSING_COLUMN)
    ledger.record("run_sql", MISSING_TABLE)

    assert ledger.abandoned == []


# ---------------------------------------------------------------------------
# What is refused afterwards, and what is not
# ---------------------------------------------------------------------------


def test_the_exact_call_that_kept_failing_is_not_run_again():
    ledger = RepeatedFailures()
    arguments = '{"sql": "SELECT crm_customer_ref FROM t"}'

    for _ in range(2):
        ledger.remember("run_sql", arguments, MISSING_COLUMN)
        ledger.record("run_sql", MISSING_COLUMN)

    skip = ledger.skip_repeat("run_sql", arguments)
    assert skip.startswith("SKIPPED")
    assert "was not called" in skip
    assert "crm_customer_ref" in skip, "the model needs the original error to act on"


def test_a_corrected_call_still_runs():
    """The difference between abandoning a dead end and disabling a tool.

    The skip message tells the model to make one corrected call, so a loop that
    then refused the corrected call would be giving advice it does not honour.
    """

    ledger = RepeatedFailures()
    dead = '{"sql": "SELECT crm_customer_ref FROM t"}'

    for _ in range(2):
        ledger.remember("run_sql", dead, MISSING_COLUMN)
        ledger.record("run_sql", MISSING_COLUMN)

    assert ledger.skip_repeat("run_sql", '{"sql": "SELECT player_id FROM t"}') == ""


def test_a_repeat_of_a_call_that_only_failed_once_still_runs():
    ledger = RepeatedFailures()
    arguments = '{"sql": "SELECT 1"}'

    ledger.remember("run_sql", arguments, MISSING_COLUMN)
    ledger.record("run_sql", MISSING_COLUMN)

    assert ledger.skip_repeat("run_sql", arguments) == ""


# ---------------------------------------------------------------------------
# Saying so
# ---------------------------------------------------------------------------


def test_the_caveat_says_the_run_stopped_trying_rather_than_ran_out():
    """The half a reader acts on. "Budget spent" invites a retry; this does not."""

    ledger = RepeatedFailures()
    ledger.record("run_sql", MISSING_COLUMN)
    ledger.record("run_sql", MISSING_COLUMN)

    caveat = ledger.caveat()
    assert "run_sql" in caveat
    assert "abandoned rather than retried" in caveat
    assert "budget" not in caveat.lower()


def test_a_run_that_never_gave_up_produces_no_caveat():
    assert RepeatedFailures().caveat() == ""


def test_the_caveat_names_each_surface_once_however_many_ways_it_failed():
    ledger = RepeatedFailures()
    for message in (MISSING_COLUMN, MISSING_COLUMN, MISSING_TABLE, MISSING_TABLE):
        ledger.record("run_sql", message)

    assert ledger.caveat().count("run_sql") == 1
