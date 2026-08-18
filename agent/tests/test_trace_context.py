"""That a tool call run on a worker thread still lands in the turn's trace.

THIS IS THE TEST THAT MAKES PARALLEL TOOL CALLS SHIPPABLE. The perf note that
asked for them assumed MLflow trace context is "thread-local and inherited by
workers, so MLflow spans survive". It is not, and they do not. Under MLflow 3.14
a bare `ThreadPoolExecutor.submit` starts the worker with an EMPTY context, so
`mlflow.start_span` inside `tools.py` opens a brand-new root span in a brand-new
trace: the call still runs, still returns, still answers correctly, and simply
does not appear in the run anybody later reads.

That failure is invisible from the outside, which is why it is pinned here
rather than left to a reviewer. A dropped span costs nothing at answer time and
everything at audit time -- the Run Explorer, the per-request record and every
"what did this turn actually read" question are all served by the trace. Losing
tool spans to a thread pool would quietly delete the evidence for exactly the
calls that touch governed data.

`test_naive_submit_orphans_the_span` is the control, and it asserts the BROKEN
behaviour on purpose. If a future MLflow propagates context into pool workers by
itself, that test fails, and the failure is the notice that
`_in_trace_context` has become dead weight and can be removed deliberately
instead of being carried forever on a stale assumption.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import mlflow
import pytest

from agent import _in_trace_context


@pytest.fixture()
def tracing(tmp_path, monkeypatch):
    """A real tracing backend, so spans are spans and not no-ops.

    Without a tracking destination MLflow hands back `MLFLOW_NO_OP_SPAN`, whose
    parent and trace ids are `None` and equal to each other's for every span
    ever created. Every assertion below would pass against it while proving
    nothing at all, so the backend is explicit.
    """

    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    mlflow.set_tracking_uri(f"sqlite:///{tmp_path}/mlflow.db")
    mlflow.set_experiment("trace-context")
    yield


def _child_ids(tag: str) -> tuple[str | None, str]:
    """Open a span the way a tool does, and report where it landed."""

    with mlflow.start_span(name=f"tool.{tag}", span_type="TOOL") as span:
        return span.parent_id, span.trace_id


def test_tracing_fixture_produces_real_spans(tracing):
    """The fixture itself, so a no-op backend cannot make the rest vacuous."""

    with mlflow.start_span(name="parent") as parent:
        assert parent.span_id, "no span id: tracing is disabled, every assertion below is void"
        assert not parent.trace_id.startswith("MLFLOW_NO_OP")


def test_naive_submit_orphans_the_span(tracing):
    """The defect, asserted. See the module note: this failing is good news."""

    with mlflow.start_span(name="parent") as parent:
        with ThreadPoolExecutor(max_workers=1) as pool:
            parent_id, trace_id = pool.submit(_child_ids, "naive").result()

    assert parent_id is None, "MLflow now inherits context; _in_trace_context is dead weight"
    assert trace_id != parent.trace_id


def test_in_trace_context_keeps_the_worker_in_the_turns_trace(tracing):
    """The fix: same trace, and parented to the span that dispatched the batch."""

    with mlflow.start_span(name="parent") as parent:
        with ThreadPoolExecutor(max_workers=1) as pool:
            parent_id, trace_id = pool.submit(_in_trace_context(_child_ids, "fixed")).result()

    assert trace_id == parent.trace_id
    assert parent_id == parent.span_id


def test_every_call_in_a_batch_lands_in_the_same_trace(tracing):
    """A whole batch, because one span surviving is not the claim being made.

    The batch is what A1 actually dispatches, and a partial result is the worst
    of the three outcomes: a trace holding two of three tool calls reads as a
    turn that made two, and nothing marks the third as missing.
    """

    with mlflow.start_span(name="parent") as parent:
        with ThreadPoolExecutor(max_workers=3) as pool:
            landed = [
                future.result()
                for future in [
                    pool.submit(_in_trace_context(_child_ids, tag))
                    for tag in ("describe", "search", "sql")
                ]
            ]

    assert [trace_id for _, trace_id in landed] == [parent.trace_id] * 3
    assert [span_parent for span_parent, _ in landed] == [parent.span_id] * 3


def test_the_worker_result_is_returned_and_exceptions_propagate(tracing):
    """The wrapper is a wrapper: it must not swallow either outcome.

    A helper that returned None on success would make every parallel tool call
    look like a tool that answered nothing, and one that swallowed the
    exception would turn a warehouse outage into a silent empty result -- both
    of which read to the model as evidence rather than as a failure.
    """

    def raises() -> None:
        raise RuntimeError("warehouse unavailable")

    with mlflow.start_span(name="parent"):
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert pool.submit(_in_trace_context(lambda value: value, 41 + 1)).result() == 42
            with pytest.raises(RuntimeError, match="warehouse unavailable"):
                pool.submit(_in_trace_context(raises)).result()
