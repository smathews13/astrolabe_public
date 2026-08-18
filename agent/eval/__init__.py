"""Offline evaluation of the agent: the scorers, the held-out set, the runner.

Separate from the runtime package on purpose. Nothing under `agent/` imports
anything from here, so an evaluation concern can never end up on the answer
path -- which is the same rule the judge model already follows, and for the same
reason: a model that grades answers must not be a model that produces them.

The three modules:

- `scorers.py`  the MLflow `@scorer` functions. ONE definition, used for
                development runs, for the pre-release run, and for production
                monitoring. There is deliberately no per-environment variant.
- `dataset.py`  the held-out labelled set, and a full statement of how its
                labels were produced and by whom.
- `run_eval.py` the driver: `mlflow.genai.evaluate()` over the set, and the
                scorecard artifact the Benchmark Lab renders.
"""
