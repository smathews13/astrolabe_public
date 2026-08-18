"""Stop a run spending its budget failing the same way over and over.

A measured run issued five `run_sql` calls that all died on the same missing
column. The warehouse's FIRST error already named the real column; the four
after it bought nothing, and they bought it out of a twelve-call budget, so the
turn ended on a forced partial answer to a question that was answerable.

The rule is deliberately narrow. TWO identical failures, then that line of
attack is abandoned -- not one, because a first failure the model has now READ
is a fact it did not have when it made the call, and a considered retry after
reading it is the recovery the whole loop is built around. The second identical
failure is where a retry stops being considered.

WHAT COUNTS AS IDENTICAL is the error, not the arguments. That is the whole
point: two DIFFERENT statements that both die on the same missing column are the
same dead end, and keying on the arguments would miss exactly the case this
exists for. `signature` therefore collapses a message to its error code and the
first identifier it quotes, and ignores which statement produced it.

REFUSALS ARE NOT FAILURES AND ARE NOT COUNTED HERE. A governance refusal has its
own escalation in `refusal_guidance`, which gives a run one reshaped attempt and
then tells it to stop. Feeding refusals into this as well would brake a control
that is already braking itself, and would make a refused query look like an
outage in the trace.

THE RUN STILL ANSWERS. Abandoning a line of attack is not ending the turn: every
tool that succeeded still contributed, the model is told plainly what was
skipped and why, and it answers from what it has. What must never happen is the
run reporting that it ran out of budget when what actually happened is that it
gave up on a dead end -- the app's step rail and Run Explorer both read these
events, and a reader deciding whether to retry needs the true reason.
"""

from __future__ import annotations

import re

#: How many times one tool may fail the same way before the run stops trying.
#:
#: Two, not one. See the module note: the first failure is information the model
#: did not have, and acting on it is the recovery path.
MAX_IDENTICAL_FAILURES = 2

#: Envelopes the loop wraps a failure in before this sees it. Stripped so that
#: the same warehouse error reported through two different tools still collapses
#: to the same key, and so the tool name does not become part of the signature
#: twice over (it is already part of the ledger key).
_ENVELOPES = (
    re.compile(r"^ERROR: tool '[^']*' failed:\s*", re.IGNORECASE),
    re.compile(r"^ERROR: [A-Za-z_]+ (?:failed|was REFUSED)[:,]?\s*", re.IGNORECASE),
    re.compile(r"^ERROR:\s*", re.IGNORECASE),
)

#: A Databricks error code: SCREAMING_SNAKE, optionally dotted
#: (`UNRESOLVED_COLUMN.WITH_SUGGESTION`). Five characters minimum, so an
#: ordinary capitalised word in prose is not mistaken for one.
_CODE = re.compile(r"\b[A-Z][A-Z0-9_]{4,}(?:\.[A-Z0-9_]+)*\b")

#: The first identifier the message quotes, which is usually the column or table
#: that was missing. Backticks, single and double quotes all appear in practice.
_IDENTIFIER = re.compile(r"[`'\"]([A-Za-z_][A-Za-z0-9_.]*)[`'\"]")


def signature(message: str) -> str:
    """A key for one failure that ignores which statement produced it.

    Falls back to a normalised prefix when there is no code to find. The prefix
    is deliberately generous: over-collapsing brakes two unrelated failures
    together, which costs a retry the model is told about, while under-collapsing
    fails to brake at all, which is the defect this module exists for.
    """

    collapsed = " ".join((message or "").split())
    for envelope in _ENVELOPES:
        collapsed = envelope.sub("", collapsed, count=1)
    code = _CODE.search(collapsed)
    identifier = _IDENTIFIER.search(collapsed)
    if code:
        return f"{code.group(0)}|{identifier.group(1).lower() if identifier else ''}"
    # Trailing punctuation stripped, or the same prose reported with and without
    # a full stop keys twice and a failure with no error code -- a Genie timeout,
    # a transport error -- never brakes at all.
    return collapsed[:80].lower().rstrip(".!? ")


class RepeatedFailures:
    """The failures one run has seen, and which lines of attack it has given up.

    Scoped to a run rather than to a step. A step-scoped ledger would let the
    model reissue the same dead statement on the next turn, which is most of the
    behaviour being removed: the measured run spread its five identical failures
    across turns as well as within one.
    """

    def __init__(self, limit: int = MAX_IDENTICAL_FAILURES) -> None:
        self.limit = limit
        #: (tool, signature) -> how many times it has failed.
        self._counts: dict[tuple[str, str], int] = {}
        #: (tool, signature) -> the first message, for the skip text and caveat.
        self._first: dict[tuple[str, str], str] = {}
        #: (tool, arguments) -> the signature that exact call produced. What lets
        #: a repeat be recognised BEFORE it is run, which the signature alone
        #: cannot do: a signature is derived from an error nobody has seen yet.
        self._by_call: dict[tuple[str, str], str] = {}
        #: Lines of attack given up on, in the order they were given up.
        self.abandoned: list[tuple[str, str]] = []

    def remember(self, tool: str, arguments: str, message: str) -> None:
        """Tie one exact call to the failure it produced."""

        self._by_call[(tool, arguments)] = signature(message)

    def skip_repeat(self, tool: str, arguments: str) -> str:
        """Why this exact call is not being run again, or "" to run it.

        Keyed on the ARGUMENTS as well as the tool, so a corrected statement
        still runs. That is the difference between abandoning a dead end and
        disabling a tool, and the model is explicitly told to make one corrected
        call, so disabling the tool would be advice the loop then refuses to
        honour.
        """

        found = self._by_call.get((tool, arguments))
        if found is None or self._counts.get((tool, found), 0) < self.limit:
            return ""
        return self._skip_text(tool, found)

    def record(self, tool: str, message: str) -> bool:
        """Note one failed call. True when this is the one that gives up.

        True EXACTLY ONCE per key, so a caller can announce the decision without
        announcing it again on every later call that matches.
        """

        key = (tool, signature(message))
        self._counts[key] = self._counts.get(key, 0) + 1
        self._first.setdefault(key, " ".join((message or "").split()))
        if self._counts[key] == self.limit:
            self.abandoned.append(key)
            return True
        return False

    def gave_up_on(self, tool: str, message: str) -> bool:
        """Whether this tool has already failed this way enough times."""

        return self._counts.get((tool, signature(message)), 0) >= self.limit

    def skip_batch(self, tool: str) -> str:
        """Why the rest of THIS step's calls to `tool` are not being run.

        The model issued every call in a step before it saw any of their
        results, so the later ones cannot be a considered response to the
        earlier ones failing. Once a tool in a step has failed the same way
        twice, the remaining calls to it in that step are the same guess
        repeated, whatever their arguments say.
        """

        for recorded, found in self.abandoned:
            if recorded == tool:
                return self._skip_text(tool, found)
        return ""

    def _skip_text(self, tool: str, found: str) -> str:
        """What the model is told instead of running the call again.

        Names the original error, because that error is what the model has to
        act on and it is now several messages back. Says the call was NOT run,
        so a skipped step is never read as a query that returned nothing.
        """

        preview = self._first.get((tool, found), "")[:300]
        return (
            f"SKIPPED — {tool} was not called. It has already failed this way "
            f"{self.limit} times in this run: {preview}\nCalling it again will fail "
            "identically and spend budget you need for the rest of the question. That "
            "error names the real column or table: confirm it with describe_table, using "
            "its `columns` filter, then make ONE corrected call — or answer from what you "
            "already have and say what you could not check."
        )

    def caveat(self) -> str:
        """One line for the answer, naming what was given up on.

        Sorted and deduplicated by tool, because the reader cares which surface
        stopped being useful, not how many signatures it produced.
        """

        tools = sorted({tool for tool, _ in self.abandoned})
        if not tools:
            return ""
        named = tools[0] if len(tools) == 1 else ", ".join(tools[:-1]) + f" and {tools[-1]}"
        return (
            f"{named} failed the same way repeatedly, so that line of enquiry was "
            "abandoned rather than retried. This answer is based on what the other steps "
            "returned, so part of the question may not be covered."
        )
