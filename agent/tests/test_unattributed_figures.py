"""The escape valve for a missing metric layer, and the ways it must not open.

The gateway refuses a Genie result whose figures cannot be traced to a read. That
is right, and until somebody builds a semantic metric layer it has a cost with no
sanctioned workaround: a chart-only answer returns nothing, mid-conversation, in
front of a customer. This flag is the valve.

Most of these tests are about it being SHUT. That is the interesting direction:
the failure mode of an escape valve is not that it fails to open, which somebody
notices within a minute, but that it is open when nobody meant it to be, which
nobody notices at all. So the exact-string contract, the artifact round trip and
the "predates the flag" case all get their own test.
"""

from unattributed_figures import (
    ALLOW_UNATTRIBUTED_FIGURES_ENV,
    ENABLED_VALUE,
    MODEL_CONFIG_KEY,
    PERMISSIVE,
    STRICT,
    announcement,
    from_artifact,
    resolve,
    waiver_caveat,
)

# ---------------------------------------------------------------------------
# Fail closed, on the exact string
# ---------------------------------------------------------------------------


def test_only_the_exact_lowercase_string_opens_the_valve():
    assert resolve("true").enabled is True
    assert resolve("  true  ").enabled is True, "trimmed, because a YAML value carries whitespace"


def test_everything_else_leaves_the_gateway_strict():
    """The whole list, because each of these is somebody's idea of yes.

    Matching the demo-content flag rather than the identity flag next door, which
    lowercases. Both are defensible and this one follows the setting whose question
    is closest to it: may something reach a screen that a reader cannot verify.
    """

    for value in (None, "", "  ", "1", "yes", "on", "TRUE", "True", "tru", "false", "0", "no"):
        assert resolve(value).enabled is False, f"{value!r} must not open the valve"


def test_a_typo_is_reported_rather_than_silently_ignored():
    """Silence here is the worst outcome, and not for the obvious reason.

    Somebody who wrote TRUE meaning yes believes the valve is open. They find out
    it is not during the demo it was turned on for, which is the exact moment the
    flag exists to protect.
    """

    resolution = resolve("TRUE")

    assert resolution.reason == "unrecognised"
    assert resolution.mode == STRICT
    line = announcement(resolution, at_log_time=True)
    assert "not a value this agent recognises" in line
    assert "IGNORED" in line
    assert ENABLED_VALUE in line, "and the line says what the accepted value is"


def test_the_modes_are_named_for_reporting():
    assert resolve("true").mode == PERMISSIVE
    assert resolve(None).mode == STRICT


# ---------------------------------------------------------------------------
# The artifact round trip
#
# The container inherits nothing from the shell that logged the model, so this is
# the path that actually decides a served version's behaviour.
# ---------------------------------------------------------------------------


def test_a_version_logged_before_this_flag_existed_is_strict():
    """The upgrade case, and the one a default in the wrong place would break."""

    assert from_artifact({}).enabled is False
    assert from_artifact(None).enabled is False
    assert from_artifact({"user_authorization": True}).enabled is False


def test_the_flag_survives_yaml_as_a_bool_or_as_a_string():
    """MLflow round-trips model_config through YAML, so both shapes arrive."""

    assert from_artifact({MODEL_CONFIG_KEY: True}).enabled is True
    assert from_artifact({MODEL_CONFIG_KEY: "true"}).enabled is True
    assert from_artifact({MODEL_CONFIG_KEY: False}).enabled is False
    assert from_artifact({MODEL_CONFIG_KEY: "TRUE"}).enabled is False, (
        "the exact-string rule holds on the way back out of the artifact too"
    )


# ---------------------------------------------------------------------------
# Being noticed
#
# A permissive gateway nobody notices is how this class of defect returns.
# ---------------------------------------------------------------------------


def test_the_permissive_announcement_says_what_will_happen_and_why_it_exists():
    line = announcement(resolve("true"), at_log_time=True)

    assert "UNATTRIBUTED FIGURES ARE ALLOWED" in line
    assert "instead of refused" in line, "the behaviour, not just the name of the setting"
    assert "no semantic metric layer" in line, (
        "the reason, so whoever reads this knows what would let them turn it off"
    )
    assert ALLOW_UNATTRIBUTED_FIGURES_ENV in line


def test_the_strict_announcement_still_says_what_the_behaviour_is():
    """Printed on every release, on or off, because "why did that answer refuse"
    should never have to be inferred from which flags somebody remembers setting.
    """

    line = announcement(resolve(None), at_log_time=True)

    assert "strict" in line
    assert "refused" in line
    assert "ask for a table" in line


def test_the_artifact_announcement_names_the_artifact_not_the_environment():
    """Different wording on purpose: at serve time the environment variable is
    irrelevant and looking for it is a wasted hour, because the value that decided
    the behaviour was baked weeks earlier.
    """

    line = announcement(from_artifact({MODEL_CONFIG_KEY: True}), at_log_time=False)

    assert "in the model artifact" in line
    assert ALLOW_UNATTRIBUTED_FIGURES_ENV not in line


def test_the_reader_facing_caveat_says_what_is_wrong_and_what_to_do():
    """The only disclosure that reaches the person who might act on the number.

    The boot lines are read by whoever deployed the release. Nobody reading an
    answer knows a setting was flipped weeks ago on their behalf.
    """

    caveat = waiver_caveat()

    assert "could not be traced" in caveat
    assert "without a source" in caveat
    assert "indicative" in caveat, "usable guidance rather than only an apology"
    assert "as a table" in caveat, "and the way to get figures somebody can check"


def test_the_module_is_named_for_its_consequence_not_its_mechanism():
    """Pinned because the rename would be an easy tidy-up with a real cost.

    Somebody typing PLAYER_INSIGHTS_ALLOW_UNATTRIBUTED_FIGURES has to read what it
    does on the way past. RELAX_GENIE_VALIDATION or PERMISSIVE_GATEWAY sound like
    tuning, and tuning gets turned on to see if it helps.
    """

    assert ALLOW_UNATTRIBUTED_FIGURES_ENV == "PLAYER_INSIGHTS_ALLOW_UNATTRIBUTED_FIGURES"
    assert MODEL_CONFIG_KEY == "allow_unattributed_figures"
