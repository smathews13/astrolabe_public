"""Record chat-completions token usage onto MLflow spans.

LLM calls in this agent go through `chat.completions.create` by hand rather than
through `mlflow.openai.autolog`, so the response's `usage` block never reaches a
span on its own. Without that, a reader who opens an MLflow `tr-…` id from the
app sees the prose and the errors but not how many tokens the call cost.

MLflow's Tokens column reads `mlflow.chat.tokenUsage` with `input_tokens` /
`output_tokens` / `total_tokens`. The OpenAI-compatible response uses
`prompt_tokens` / `completion_tokens` / `total_tokens`. This module bridges the
two, merges the OpenAI-shaped names into span outputs so they are visible next
to the text, and fails soft when usage is absent: a gateway that strips the
block must never take a turn down with it.
"""

from __future__ import annotations

from typing import Any

#: The attribute MLflow's UI and `trace.info.token_usage` aggregation read.
TOKEN_USAGE_ATTR = "mlflow.chat.tokenUsage"


def usage_from_response(response: Any) -> dict[str, int] | None:
    """OpenAI-shaped token counts from a chat completions response, or None.

    Accepts both attribute access (`response.usage.prompt_tokens`) and dict
    shaped usage, because fakes and some gateways return one or the other.
    """

    try:
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if usage is None:
            return None

        def _count(*names: str) -> int | None:
            for name in names:
                value = getattr(usage, name, None)
                if value is None and isinstance(usage, dict):
                    value = usage.get(name)
                if value is None:
                    continue
                return int(value)
            return None

        prompt = _count("prompt_tokens", "input_tokens")
        completion = _count("completion_tokens", "output_tokens")
        total = _count("total_tokens")
        if prompt is None and completion is None and total is None:
            return None
        prompt = prompt or 0
        completion = completion or 0
        if total is None:
            total = prompt + completion
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
        }
    except (TypeError, ValueError, AttributeError):
        return None


def record_llm_usage(span: Any, response: Any) -> dict[str, int] | None:
    """Write usage onto `span` and return the OpenAI-shaped counts, or None.

    Sets `mlflow.chat.tokenUsage` for the MLflow Tokens column, and merges
    `prompt_tokens` / `completion_tokens` / `total_tokens` into the span's
    current outputs so a reader opening the span sees the same numbers without
    hunting attributes. Call this AFTER any `set_outputs` that would otherwise
    replace the whole outputs dict.

    Never raises: missing span, missing usage, or a span that rejects the write
    is treated as absent.
    """

    usage = usage_from_response(response)
    if usage is None or span is None:
        return usage
    try:
        span.set_attribute(
            TOKEN_USAGE_ATTR,
            {
                "input_tokens": usage["prompt_tokens"],
                "output_tokens": usage["completion_tokens"],
                "total_tokens": usage["total_tokens"],
            },
        )
        current = dict(getattr(span, "outputs", None) or {})
        current.update(usage)
        span.set_outputs(current)
    except Exception:
        # The turn already has its answer; losing the meter must not lose the turn.
        return usage
    return usage
