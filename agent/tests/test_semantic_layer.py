"""The semantic layer's source-table schema, and what it refuses to build.

The schema is the expensive decision in this workstream. An AI Search Delta Sync
index is defined against a source table's columns, so a column added or renamed
after the index exists means rebuilding the index, and a filter dimension that
was not made a column cannot be filtered on at all. These tests hold the shape.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

import semantic_layer as sl

FIXED_TIME = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)


def column(name: str, comment: str = "") -> sl.ColumnDescription:
    return sl.ColumnDescription(name=name, type_text="string", comment=comment)


class TestSchema:
    def test_every_declared_column_is_written_by_a_row(self):
        """A column added to the DDL without a value written into it would be a
        null in a NOT NULL column, discovered at build time against a warehouse."""

        entry = sl.definition_entry(sl.KIND_TERM, "churn", "A player who stopped playing.")
        assert set(entry.as_row()) == set(sl.COLUMN_NAMES)

    def test_filter_columns_exist_in_the_schema(self):
        for name in sl.FILTER_COLUMNS:
            assert name in sl.COLUMN_NAMES

    def test_retrieved_columns_exist_in_the_schema(self):
        for name in sl.RETRIEVED_COLUMNS:
            assert name in sl.COLUMN_NAMES

    def test_authorized_scope_is_not_pushed_down_as_a_filter(self):
        """The one test the whole scope design rests on. Pushing the scope test
        into the index would make correctness depend on array-filter semantics
        nothing here can exercise without provisioning an endpoint."""

        assert "authorized_scope" not in sl.FILTER_COLUMNS
        assert "authorized_scope" in sl.RETRIEVED_COLUMNS

    def test_ddl_enables_change_data_feed(self):
        """Delta Sync reads the feed. Without it the table looks correct and the
        index creation fails later, against a workspace, for a reason the DDL
        does not mention."""

        ddl = sl.create_table_sql("cat.sch.semantic_layer_entries")
        assert "delta.enableChangeDataFeed = true" in ddl

    def test_ddl_declares_every_column_in_order(self):
        ddl = sl.create_table_sql("cat.sch.semantic_layer_entries")
        positions = [ddl.index(f"  {name} ") for name in sl.COLUMN_NAMES]
        assert positions == sorted(positions)

    def test_ddl_quotes_a_comment_containing_an_apostrophe(self):
        """Comments arrive from a customer's Unity Catalog, so they are arbitrary
        text and one of them will contain a quote."""

        assert sl.sql_string("it's") == "'it''s'"
        assert sl.sql_string("back\\slash") == "'back\\\\slash'"

    def test_primary_key_and_embedded_column_are_real_columns(self):
        assert sl.PRIMARY_KEY in sl.COLUMN_NAMES
        assert sl.EMBEDDED_COLUMN in sl.COLUMN_NAMES

    def test_source_and_index_names_are_three_level(self):
        assert sl.source_table("cat", "sch") == "cat.sch.semantic_layer_entries"
        assert sl.index_name("cat", "sch") == "cat.sch.semantic_layer_index"


class TestEntryIdentity:
    def test_entry_id_is_stable_across_rebuilds(self):
        """A rebuild must MERGE. An id derived from content would make an edited
        description a second row competing with the first in every search."""

        first = sl.definition_entry(
            sl.KIND_METRIC, "active players", "Players with a session in the window."
        )
        edited = sl.definition_entry(
            sl.KIND_METRIC, "active players", "Players with at least one session."
        )
        assert first.entry_id == edited.entry_id
        assert first.content_digest != edited.content_digest

    def test_entry_id_separates_kinds_that_share_a_name(self):
        metric = sl.definition_entry(sl.KIND_METRIC, "retention", "A rate.")
        term = sl.definition_entry(sl.KIND_TERM, "retention", "A concept.")
        assert metric.entry_id != term.entry_id

    def test_the_separator_cannot_be_forged_from_a_name(self):
        """Joining fields with a character a name may contain would let two
        different entries collide onto one id, and a collision silently replaces
        one deployment's semantics with another's."""

        joined = sl.definition_entry(sl.KIND_TERM, "a.b", "x", asset="cat.sch.tbl")
        split = sl.definition_entry(sl.KIND_TERM, "b", "x", asset="cat.sch.tbl.a")
        assert joined.entry_id != split.entry_id


class TestRefusals:
    def test_an_unknown_kind_is_refused(self):
        with pytest.raises(sl.SemanticLayerError, match="entry_kind"):
            sl.SemanticEntry(entry_kind="rumour", name="x", content="y")

    def test_an_unknown_certification_is_refused(self):
        with pytest.raises(sl.SemanticLayerError, match="certification"):
            sl.SemanticEntry(
                entry_kind=sl.KIND_TERM, name="x", content="y", certification="probably"
            )

    def test_a_generated_entry_may_not_claim_certification(self):
        """The default matters more than the setting. A build that inferred
        `certified` from a Unity Catalog comment would let the agent present an
        off-hand sentence as an approved definition."""

        with pytest.raises(sl.SemanticLayerError, match="may not claim"):
            sl.SemanticEntry(
                entry_kind=sl.KIND_TERM,
                name="x",
                content="y",
                certification=sl.CERTIFIED,
                source=sl.SOURCE_UNITY_CATALOG,
            )

    def test_a_curated_entry_may_claim_certification(self):
        entry = sl.SemanticEntry(
            entry_kind=sl.KIND_TERM,
            name="x",
            content="y",
            certification=sl.CERTIFIED,
            source=sl.SOURCE_CURATED,
        )
        assert entry.certification == sl.CERTIFIED

    def test_default_certification_is_uncertified(self):
        assert sl.SemanticEntry(entry_kind=sl.KIND_TERM, name="x", content="y").certification == (
            sl.UNCERTIFIED
        )

    def test_default_scope_is_nobody(self):
        """Empty means nobody, never everybody. A build that could not read an
        asset's grants must not fall back to publishing its semantics."""

        entry = sl.SemanticEntry(entry_kind=sl.KIND_TERM, name="x", content="y")
        assert entry.authorized_scope == ()

    def test_a_two_part_asset_is_refused(self):
        with pytest.raises(sl.SemanticLayerError, match="fully-qualified"):
            sl.table_entries("sch.tbl", [column("a")])

    def test_a_table_with_no_columns_is_refused(self):
        with pytest.raises(sl.SemanticLayerError, match="no columns"):
            sl.table_entries("cat.sch.tbl", [])

    def test_oversized_content_is_refused_rather_than_trimmed(self):
        with pytest.raises(sl.SemanticLayerError, match="Split it across entries"):
            sl.SemanticEntry(
                entry_kind=sl.KIND_TERM, name="x", content="y" * (sl.MAX_CONTENT_CHARS + 1)
            )


class TestTableEntries:
    def test_a_narrow_table_is_one_entry_naming_every_column(self):
        entries = sl.table_entries(
            "cat.sch.tbl",
            [column("player_id", "Surrogate key."), column("country")],
            table_comment="Player profiles.",
        )
        assert len(entries) == 1
        assert "player_id" in entries[0].content
        assert "country" in entries[0].content
        assert "Player profiles." in entries[0].content
        assert entries[0].asset == "cat.sch.tbl"

    def test_a_wide_table_is_split_and_every_part_says_so(self):
        """describe_table once returned the first fifty columns of a wide table
        with nothing on the text to say it was partial. Splitting rather than
        trimming is the fix, and a part that does not announce itself is the
        same defect wearing a different shape."""

        columns = [column(f"c{n}", "x" * 200) for n in range(80)]
        entries = sl.table_entries("cat.sch.wide", columns)
        assert len(entries) > 1
        for entry in entries:
            assert len(entry.content) <= sl.MAX_CONTENT_CHARS
            assert "part" in entry.content
            assert "cat.sch.wide" in entry.content
        indexed = "\n".join(entry.content for entry in entries)
        for name in (f"c{n}" for n in range(80)):
            assert name in indexed

    def test_split_parts_get_distinct_ids(self):
        columns = [column(f"c{n}", "x" * 200) for n in range(80)]
        entries = sl.table_entries("cat.sch.wide", columns)
        assert len({entry.entry_id for entry in entries}) == len(entries)

    def test_a_single_unfittable_column_is_a_data_problem_not_a_split(self):
        with pytest.raises(sl.SemanticLayerError, match="does not fit an entry on its own"):
            sl.table_entries("cat.sch.tbl", [column("c", "x" * sl.MAX_CONTENT_CHARS)])

    def test_the_split_is_stable_for_the_same_input(self):
        columns = [column(f"c{n}", "x" * 200) for n in range(80)]
        first = sl.table_entries("cat.sch.wide", columns, generated_at=FIXED_TIME)
        again = sl.table_entries("cat.sch.wide", columns, generated_at=FIXED_TIME)
        assert [entry.as_row() for entry in first] == [entry.as_row() for entry in again]


class TestDefinitionEntries:
    def test_the_name_is_embedded_with_the_definition(self):
        """Managed embeddings see only the embedded column, so a metric whose
        name appears nowhere in its content cannot be found by its name."""

        entry = sl.definition_entry(sl.KIND_METRIC, "day-7 retention", "A rate over a week.")
        assert "day-7 retention" in entry.content

    def test_a_table_may_not_be_built_as_a_definition(self):
        with pytest.raises(sl.SemanticLayerError, match="use table_entries"):
            sl.definition_entry(sl.KIND_TABLE, "cat.sch.tbl", "A table.")

    def test_an_asset_scoped_definition_names_its_asset(self):
        entry = sl.definition_entry(
            sl.KIND_JOIN, "profiles to purchases", "Join on the surrogate key.", asset="cat.sch.p"
        )
        assert "cat.sch.p" in entry.content


class TestScopeTokens:
    def test_a_group_called_all_users_is_not_the_public_token(self):
        assert sl.group_scope("all-users") != sl.PUBLIC_SCOPE

    def test_a_user_token_is_case_folded(self):
        """One human arrives as a forwarded email, as a SCIM userName and as a
        Unity Catalog grantee, and those have been seen to differ in case."""

        assert sl.user_scope("A.Person@Example.com") == sl.user_scope("a.person@example.com")

    def test_a_group_token_is_not_case_folded(self):
        """Two groups differing only in case are two groups. Folding them
        together is a widening, and a widening here is an exposure."""

        assert sl.group_scope("Analysts") != sl.group_scope("analysts")


class TestRebuildOverdue:
    """The five-day outage, as arithmetic.

    From 11 to 15 August 2026 the rebuild failed every night on the schedule.
    Nothing noticed, because every surface that could have was reporting on the
    wrong thing: the job's last run had a result state, the index had `ready:
    true`, and the table had rows. All three stay true through an outage of any
    length. The only witness is how old the rows are.
    """

    def test_a_layer_rebuilt_this_morning_is_current(self):
        assert not sl.rebuild_overdue(FIXED_TIME, now=FIXED_TIME + timedelta(hours=3))

    def test_a_slow_run_inside_the_grace_is_not_an_alarm(self):
        """A retry or a queued run pushes the next build past 24 hours, and
        alarming on that would train somebody to ignore the alarm."""

        assert not sl.rebuild_overdue(FIXED_TIME, now=FIXED_TIME + timedelta(hours=29))

    def test_the_five_day_outage_is_reported(self):
        """The case that happened. Five nightly failures, nothing written, and
        every check green."""

        reason = sl.rebuild_overdue(FIXED_TIME, now=FIXED_TIME + timedelta(days=5))
        assert reason
        assert "5 days" in reason

    def test_the_reason_says_why_it_matters_rather_than_only_that_it_is_old(self):
        """A staleness message that only reports an age reads as housekeeping.
        The cost is an authorization one: `authorized_scope` is exactly as stale
        as the row, so a revoked grant is still being honoured by discovery."""

        reason = sl.rebuild_overdue(FIXED_TIME, now=FIXED_TIME + timedelta(days=5))
        assert "authorized_scope" in reason
        assert "revoked" in reason

    def test_an_empty_layer_is_overdue_rather_than_fresh(self):
        """No rows and fresh rows are opposite states, and an index with no rows
        still reports `ready`. Defaulting the missing case to fresh would make
        the never-built deployment the one nothing ever complains about."""

        reason = sl.rebuild_overdue(None, now=FIXED_TIME)
        assert reason
        assert "no rows" in reason

    def test_the_boundary_is_inclusive_so_an_on_time_build_never_alarms(self):
        exactly = FIXED_TIME + sl.REBUILD_PERIOD + sl.REBUILD_GRACE
        assert not sl.rebuild_overdue(FIXED_TIME, now=exactly)
        assert sl.rebuild_overdue(FIXED_TIME, now=exactly + timedelta(hours=1))

    def test_the_grace_is_shorter_than_the_period(self):
        """A grace longer than the cadence would let two consecutive nights fail
        without a word, which is the outage this whole class is about."""

        assert sl.REBUILD_GRACE < sl.REBUILD_PERIOD
