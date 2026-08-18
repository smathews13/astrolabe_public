"""That the caller's client is reused WITHIN a turn and never ACROSS requests.

The saving is small -- three or four rounds of credential resolution and one
`current_user.me()` per turn. The failure mode is not small. Model Serving parks
one invoker's downscoped token in a thread-local per request and serves
concurrent requests from a single container, so a client that outlives its
request answers the next stakeholder's question with the previous one's Unity
Catalog grants: no exception, no warning, correct-looking numbers about somebody
else's rows. That is a governance breach rather than a performance bug, which is
why this file exists and why A4 does not ship without it.

Three properties are pinned, and the third is the one that makes the other two
worth anything:

1. WITHIN one turn, one client. That is the optimisation.
2. ACROSS turns, never the same client, even back-to-back on one thread.
3. With NO turn open, nothing is cached at all -- so a future entry point that
   forgets to open one gets the old cost, not an unowned client.

`test_execution_identity.py::test_two_concurrent_callers_are_gated_against_their
_own_identities` covers the same ground from the other end: it drives two turns
whose invoker differs and asserts each is gated against its OWN identity, which
fails outright if a turn inherits the previous turn's.
"""

from __future__ import annotations

import contextvars
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

import agent as agent_module
from agent import _TURN_CREDENTIALS, PlayerInsightsResponsesAgent
from config import Settings


@pytest.fixture()
def clients(monkeypatch):
    """A fresh, identifiable client per construction, and a count of them."""

    built: list[SimpleNamespace] = []

    def factory(*_args, **_kwargs):
        client = SimpleNamespace(
            label=f"client-{len(built)}",
            current_user=SimpleNamespace(
                me=lambda: SimpleNamespace(user_name=f"caller-{len(built) - 1}@example.com")
            ),
        )
        built.append(client)
        return client

    monkeypatch.setattr(agent_module, "user_authorized_client", factory)
    return built


@pytest.fixture()
def runtime():
    return PlayerInsightsResponsesAgent(
        settings=Settings.from_env(), user_authorization=True, llm_client=object()
    )


@pytest.fixture(autouse=True)
def _no_turn_left_open():
    """No test may leave a memo behind for the next one to find."""

    yield
    _TURN_CREDENTIALS.set(None)


def test_one_client_serves_a_whole_turn(clients, runtime):
    """The optimisation. A turn asks for its runtime four or five times."""

    _TURN_CREDENTIALS.set({})
    handed = [runtime._authorized_client() for _ in range(5)]

    assert len(clients) == 1
    assert {id(client) for client in handed} == {id(clients[0])}


def test_the_identity_is_measured_once_per_turn(clients, runtime):
    """One `current_user.me()`, not one per surface that wants to know.

    Measured, not assumed, is the invariant -- and it survives: the first ask is
    a real round trip against the real client. What is gone is the second ask of
    the same client inside one turn, which could only return the same answer.
    """

    asked: list[str] = []

    _TURN_CREDENTIALS.set({})
    client = runtime._authorized_client()
    client.current_user.me = lambda: (
        asked.append("me") or SimpleNamespace(user_name="ada@example.com")
    )

    assert runtime._measured_identity(client) == "ada@example.com"
    assert runtime._measured_identity(client) == "ada@example.com"
    assert runtime._invoker_identity() == "ada@example.com"
    assert asked == ["me"], "the same client was asked who it is more than once in one turn"


def test_a_second_turn_never_inherits_the_first_turns_client(clients, runtime):
    """Back-to-back turns on ONE thread, which is the leak that would happen.

    Sequential rather than threaded on purpose: a memo that survives its turn
    fails this every time, where a threaded version would fail it intermittently.
    """

    _TURN_CREDENTIALS.set({})
    first = runtime._authorized_client()
    _TURN_CREDENTIALS.set(None)  # what `_turn`'s finally does

    _TURN_CREDENTIALS.set({})
    second = runtime._authorized_client()

    assert first is not second
    assert len(clients) == 2


def test_a_new_turn_replaces_a_memo_it_finds_rather_than_reading_it(clients, runtime):
    """Belt to the `finally`'s braces.

    If a turn is ever abandoned without its teardown running -- a streaming
    caller that walks away, a thread pool that keeps a context alive -- the next
    turn on that context must still not inherit the client. It does not, because
    opening a turn OVERWRITES the memo. This asserts the overwrite, not the
    cleanup, so the guarantee does not depend on the cleanup happening.
    """

    _TURN_CREDENTIALS.set({})
    stale = runtime._authorized_client()

    # No teardown. Straight into the next turn, as `_turn` opens it.
    _TURN_CREDENTIALS.set({})
    fresh = runtime._authorized_client()

    assert fresh is not stale


def test_no_open_turn_means_nothing_is_cached(clients, runtime):
    """The important half: an unowned client is worse than a slow one.

    `_TURN_CREDENTIALS` defaults to None, and None means DO NOT CACHE rather
    than "the cache is empty". An entry point added later that forgets to open a
    turn therefore pays the cost this change removed, instead of parking a client
    with no owner and no expiry where the next caller can pick it up.
    """

    assert _TURN_CREDENTIALS.get() is None

    first = runtime._authorized_client()
    second = runtime._authorized_client()

    assert first is not second
    assert len(clients) == 2
    assert _TURN_CREDENTIALS.get() is None, "a client was cached with no turn to own it"


def test_the_identity_is_not_answered_from_another_clients_measurement(clients, runtime):
    """A memo for one client must never answer for a different one.

    The turn's own client is answered from the memo; anything else -- the
    passthrough client, a client a test injected, a client built after a
    refusal -- is asked outright. Reporting the turn's identity for a client that
    is not the turn's is the same lie as caching across requests, just narrower.
    """

    _TURN_CREDENTIALS.set({})
    mine = runtime._authorized_client()
    mine.current_user.me = lambda: SimpleNamespace(user_name="ada@example.com")
    assert runtime._measured_identity(mine) == "ada@example.com"

    someone_else = SimpleNamespace(
        current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name="sp@example.com"))
    )
    assert runtime._measured_identity(someone_else) == "sp@example.com"


def test_a_worker_thread_cannot_see_another_turns_credentials(clients, runtime):
    """Concurrent requests, which is how Model Serving actually serves.

    A ContextVar is per-context, and a thread that no turn opened a memo in sees
    the default. So a second request running beside the first gets its own client
    even if it lands on a pool thread the first request's work also used --
    which, with A1 running tool calls on a pool, it now can.
    """

    _TURN_CREDENTIALS.set({})
    mine = runtime._authorized_client()

    with ThreadPoolExecutor(max_workers=1) as pool:
        # No context copied in: a fresh request's thread, as Model Serving hands
        # one over.
        theirs = pool.submit(runtime._authorized_client).result()
        seen = pool.submit(_TURN_CREDENTIALS.get).result()

    assert theirs is not mine
    assert seen is None, "one request's credentials were visible from another's thread"


def test_a_copied_context_hands_the_worker_the_same_turns_client(clients, runtime):
    """And the deliberate opposite, so the isolation above is not accidental.

    A1 copies the context onto its workers on purpose, to carry the MLflow trace.
    That copy carries this memo too, and that is correct: those workers are doing
    THIS turn's tool calls and must read this turn's data as this turn's caller.
    A worker that built its own client would be resolving credentials from the
    same thread-local anyway -- the same token, at more cost.
    """

    _TURN_CREDENTIALS.set({})
    mine = runtime._authorized_client()

    context = contextvars.copy_context()
    with ThreadPoolExecutor(max_workers=1) as pool:
        theirs = pool.submit(context.run, runtime._authorized_client).result()

    assert theirs is mine
    assert len(clients) == 1
