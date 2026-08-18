"""Whether this release may put a figure on screen that nobody can trace.

The evidence gateway refuses a Genie result whose figures cannot be attributed to
a read: an unparseable statement, a query attachment that exposed no SQL, or a
chart with no query behind it. That is the intended behaviour and it is on by
default. This module is the switch that turns it back into a caveat, and it exists
for one reason: the sanctioned way to attribute a chart is a governed semantic
metric, and there is no metric layer. The demo schema is twelve plain managed
tables, so `metric_ids` is a real route with nothing on it, and will stay that way
until somebody builds one.

WITHOUT THIS FLAG THE REFUSAL IS CORRECT AND STILL COSTS SOMETHING VISIBLE. A data
space that answers a question with a chart returns nothing, mid-conversation, in
front of a customer. The model is told to re-ask for a table, which usually works
and costs a turn, but "usually" is not what anyone wants to discover during a
demo. So there is an escape valve, and the escape valve is deliberately awkward.

FAIL CLOSED, ON THE EXACT STRING. Unset, empty, `1`, `yes`, `TRUE` and a typo all
mean strict. This follows `PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL`, the other
flag of this shape in this repo, for the same reason: the safe value has to be the
one you get by doing nothing, saying nothing, and misspelling it.

IT IS NAMED FOR ITS CONSEQUENCE rather than for its mechanism. Not
`RELAX_GENIE_VALIDATION` or `PERMISSIVE_GATEWAY`, which sound like tuning. Turning
this on means unattributed figures reach a reader, and anybody typing the variable
should have to read that on the way past.

AND IT ANNOUNCES ITSELF THREE TIMES, because a permissive gateway nobody notices
is how this class of defect comes back: once at log time, once when the served
model loads, and once on every answer that actually used the leniency. The third
is the one that matters. The first two are read by whoever deployed it, and the
person at risk of trusting an untraceable number is the reader.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: Read at LOG time only. This is a release decision, and the artifact carries it
#: into serving: the container inherits nothing from the shell that logged it.
ALLOW_UNATTRIBUTED_FIGURES_ENV = "PLAYER_INSIGHTS_ALLOW_UNATTRIBUTED_FIGURES"

#: The key `log_model.py` writes into `model_config` and `agent.py` reads back on
#: load. Not a `Settings` field, which names workspace values rather than
#: decisions a release makes.
MODEL_CONFIG_KEY = "allow_unattributed_figures"

#: The one accepted value. Anything else leaves the gateway strict.
ENABLED_VALUE = "true"

#: What a run says it did, for anything that reports it.
STRICT = "strict"
PERMISSIVE = "permissive"


@dataclass(frozen=True)
class Resolution:
    """What the flag was set to, and what that resolved to.

    `reason` is distinct from `enabled` so that somebody who wrote `TRUE` meaning
    yes is told it did nothing, rather than concluding the flag is broken or, far
    worse, believing the escape valve is open when it is not and finding out in
    front of an audience.
    """

    enabled: bool
    #: What the environment or artifact actually carried, for the log line.
    raw: str
    #: ``unset`` | ``enabled`` | ``disabled`` | ``unrecognised``
    reason: str

    @property
    def mode(self) -> str:
        return PERMISSIVE if self.enabled else STRICT


def resolve(raw: str | None) -> Resolution:
    """Read the flag, on the exact string, failing closed on everything else.

    Trimmed but NOT lowercased, which differs from the identity flag next door and
    matches the demo-content flag instead. Both are defensible; this one follows
    the setting whose question is closest to it, and a `TRUE` that silently worked
    would make the exact-string contract a thing that is documented rather than a
    thing that is true.
    """

    value = (raw or "").strip()
    if not value:
        return Resolution(enabled=False, raw=value, reason="unset")
    if value == ENABLED_VALUE:
        return Resolution(enabled=True, raw=value, reason="enabled")
    if value == "false":
        return Resolution(enabled=False, raw=value, reason="disabled")
    return Resolution(enabled=False, raw=value, reason="unrecognised")


def from_artifact(baked: Mapping[str, Any] | None) -> Resolution:
    """Read back what log time decided, out of the model's own configuration.

    MLflow round-trips `model_config` through YAML, so the value arrives as a bool
    or as a string. Both are accepted and everything else fails closed, including a
    version logged before this key existed, which bakes nothing and is therefore
    strict.
    """

    value = (baked or {}).get(MODEL_CONFIG_KEY)
    if value is None:
        return Resolution(enabled=False, raw="", reason="unset")
    if isinstance(value, bool):
        return Resolution(
            enabled=value, raw=str(value).lower(), reason="enabled" if value else "disabled"
        )
    return resolve(str(value))


def announcement(resolution: Resolution, *, at_log_time: bool) -> str:
    """The line to print where the flag is resolved.

    Both branches say what will happen to an unattributable Genie result, because
    that is the behaviour the setting governs and the one an operator will be
    trying to explain later.
    """

    setting = (
        f"{ALLOW_UNATTRIBUTED_FIGURES_ENV}={resolution.raw!r}"
        if at_log_time
        else f"{MODEL_CONFIG_KEY}={resolution.raw!r} in the model artifact"
    )
    if resolution.reason == "unrecognised":
        return (
            f"[evidence] {setting} is not a value this agent recognises, so it has been "
            "IGNORED and the evidence gateway remains STRICT: a Genie result whose figures "
            f'cannot be attributed is refused. The only value that relaxes it is "'
            f'{ENABLED_VALUE}", lowercase and exact. Nothing is broken, but if the escape '
            "valve was intended, it is not open."
        )
    if resolution.enabled:
        return (
            f"[evidence] UNATTRIBUTED FIGURES ARE ALLOWED ({setting}). A Genie result whose "
            "figures cannot be traced to a governed read will be ANSWERED WITH A CAVEAT "
            "instead of refused, so numbers a reader cannot check can reach the screen. This "
            "exists because there is no semantic metric layer to attribute a chart. Turn it "
            "off once there is one."
        )
    if resolution.reason == "unset":
        return (
            f"[evidence] The evidence gateway is strict "
            f"({ALLOW_UNATTRIBUTED_FIGURES_ENV} is unset): a Genie result whose figures "
            "cannot be attributed is refused, and the model is told to ask for a table."
            if at_log_time
            else f"[evidence] The evidence gateway is strict (no {MODEL_CONFIG_KEY} in the "
            "model artifact): a Genie result whose figures cannot be attributed is refused, "
            "and the model is told to ask for a table."
        )
    return (
        f"[evidence] The evidence gateway is strict ({setting}): a Genie result whose figures "
        "cannot be attributed is refused, and the model is told to ask for a table."
    )


def announce(resolution: Resolution, *, at_log_time: bool) -> Resolution:
    """Print the resolution and hand it back, so a caller can do both in one line."""

    print(announcement(resolution, at_log_time=at_log_time))
    return resolution


def waiver_caveat() -> str:
    """What an answer must say when the gateway let an untraceable figure through.

    THE ONE DISCLOSURE THAT REACHES THE PERSON AT RISK. The boot lines are read by
    whoever deployed the release; the reader of the answer is the one who might
    otherwise take an unattributable number into a decision, and they have no way
    to know a setting was flipped weeks ago on their behalf.

    Written to be usable rather than alarming: it says which part is unverifiable
    and what to do about it, because a caveat that only expresses regret gets
    skipped, and this one has to survive being read quickly.
    """

    return (
        "Part of this answer could not be traced to a governed read. The figures came from a "
        "Genie space that did not expose the query behind them, so they are reported here "
        "without a source and this agent cannot show what was counted or over which rows. "
        "Treat them as indicative rather than as reportable numbers, and ask for the same "
        "question as a table if you need figures somebody can check."
    )
