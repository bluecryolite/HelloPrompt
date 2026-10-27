# hello-world015 RAGAS evaluation

The console evaluates each assistant response with RAGAS
`AgentGoalAccuracyWithoutReference`. It sends the current conversation and
actual tool calls/results to a separate Copilot judge. The score is binary:
`1` means the judge considers the workflow compliant with the system prompt and
the compatible user goal achieved; `0` means it does not. When a user request
conflicts with the system prompt, the judge prioritizes the system prompt.
This customizes the RAGAS goal-inference and comparison prompts, so the score
is system-aware rather than the unmodified RAGAS metric. It is an LLM judgment,
not a deterministic check of factorials or tool selection.

The assistant honors explicit exclusions and additions to a range, so requested
numbers need not be consecutive. The example tool deliberately adds 100 to
each factorial result; the judge is instructed to assess the returned tool
results as authoritative rather than recalculate them.

Alongside the score, the console prints the judge's inferred `user_goal` and
`end_state`, plus the comparison `reason`. The inferred goal may reflect the
system-compliant behavior when the user's request conflicts with the system
prompt. These are outputs of the same two judge calls used for the score, not
a separate evaluation.

Install the Python dependencies separately from the Node dependencies:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r src/server/features/hello-world/requirements-ragas.txt
```

In `src/server/features/hello-world/.env`, set:

```dotenv
RAGAS_EVALUATION_MODEL=gpt-6.1-terra
RAGAS_PYTHON=.venv/bin/python
```

The model must be available to the configured Copilot account. The model
defaults to `gpt-6.1-terra` and is independent of `COPILOT_MODEL`, which
continues to control the assistant. `RAGAS_PYTHON` defaults to `python3`.
Existing process environment variables take precedence, followed by the
feature `.env`, then the project-root `.env`. Run from the project root:

```sh
npx tsx src/server/features/hello-world/hello-world015.ts
```

Each evaluation makes two additional judge calls and sends the system prompt,
conversation and tool outputs to the configured model. Evaluation errors are reported
without discarding the assistant's response or ending the console.

To run the RAGAS integration tests with the installed Python environment:

```sh
RAGAS_TEST_PYTHON=.venv/bin/python npx tsx --test src/server/hello-world-ragas.test.ts
```

To additionally check the configured live Copilot judge, set
`RAGAS_LIVE_TEST=1`; the live test makes six model calls.
