import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { config as loadEnv } from "dotenv";
import { createCopilotClient } from "./features/hello-world/core.js";
import { systemMessage } from "./features/hello-world/factorial-assistant-prompt.js";
import {
  createCopilotJudge,
  evaluateGoalAccuracy,
  evaluationMessages,
} from "./features/hello-world/ragas-evaluation.js";

test("RAGAS receives the original conversation, tool calls and outputs", () => {
  const messages = evaluationMessages(
    [{ role: "user", content: "calculate a factorial" }, { role: "assistant", content: "Which number?" }],
    "5",
    [
      new HumanMessage("synthetic prompt"),
      new AIMessage({ content: "", tool_calls: [{ name: "calcFactorial", args: { no: 5 }, id: "call-1", type: "tool_call" }] }),
      new ToolMessage({ content: '{"no":5,"factorial":220}', tool_call_id: "call-1" }),
      new AIMessage("5! = 220"),
    ],
  );
  assert.deepEqual(messages, [
    { type: "human", content: "calculate a factorial" },
    { type: "ai", content: "Which number?" },
    { type: "human", content: "5" },
    { type: "ai", content: "", tool_calls: [{ name: "calcFactorial", args: { no: 5 } }] },
    { type: "tool", content: '{"no":5,"factorial":220}' },
    { type: "ai", content: "5! = 220", tool_calls: [] },
  ]);
});

test("reports a missing Python interpreter", async () => {
  await assert.rejects(
    evaluateGoalAccuracy([{ type: "human", content: "hello" }], systemMessage, async () => "", "/no/such/python"),
    /RAGAS evaluation failed/,
  );
});

test("the judge uses the configured model in a separate session", async () => {
  let model: string | undefined;
  let prompt: string | undefined;
  let disconnected = false;
  const client = {
    async createSession(config: { model?: string }) {
      model = config.model;
      return {
        async sendAndWait(options: { prompt: string }) {
          prompt = options.prompt;
          return { data: { content: '{"verdict":"1"}' } };
        },
        async disconnect() { disconnected = true; },
      };
    },
  };
  assert.equal(await createCopilotJudge(client, "gpt-6.1-terra", "judge prompt"), '{"verdict":"1"}');
  assert.equal(model, "gpt-6.1-terra");
  assert.equal(prompt, "judge prompt");
  assert.equal(disconnected, true);
});

test("the judge disconnects even when the model fails", async () => {
  let disconnected = false;
  const client = {
    async createSession() {
      return {
        async sendAndWait(): Promise<undefined> { throw new Error("model failed"); },
        async disconnect() { disconnected = true; },
      };
    },
  };
  await assert.rejects(createCopilotJudge(client, "other-model", "prompt"), /model failed/);
  assert.equal(disconnected, true);
});

const ragasPython = process.env.RAGAS_TEST_PYTHON;
test("real RAGAS metric returns the score and both judge outputs", { skip: !ragasPython }, async () => {
  const prompts: string[] = [];
  const result = await evaluateGoalAccuracy([
    { type: "human", content: "Calculate 5 factorial" },
    { type: "ai", content: "", tool_calls: [{ name: "calcFactorial", args: { no: 5 } }] },
    { type: "tool", content: '{"no":5,"factorial":220}' },
    { type: "ai", content: "5! = 220" },
  ], systemMessage, async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? '{"user_goal":"Calculate 5 factorial","end_state":"5! = 220"}'
      : '{"reason":"The goal was not met","verdict":"0"}';
  }, ragasPython);
  assert.deepEqual(result, {
    score: 0,
    userGoal: "Calculate 5 factorial",
    endState: "5! = 220",
    reason: "The goal was not met",
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /calcFactorial/);
  assert.match(prompts[0], /220/);
  assert.match(prompts[1], /Calculate 5 factorial/);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(JSON.stringify(systemMessage).slice(1, -1)));
    assert.match(prompt, /system instruction/i);
  }
  assert.match(prompts[1], /Actual workflow/);
  assert.match(prompts[1], /calcFactorial/);
});

test("real RAGAS metric returns the success reason", { skip: !ragasPython }, async () => {
  let callCount = 0;
  const result = await evaluateGoalAccuracy([
    { type: "human", content: "say hello" },
    { type: "ai", content: "hello" },
  ], systemMessage, async () => {
    callCount += 1;
    return callCount === 1
      ? '```json\n{"user_goal":"say hello","end_state":"hello"}\n```'
      : '{"reason":"The assistant said hello","verdict":"1"}';
  }, ragasPython);
  assert.deepEqual(result, {
    score: 1,
    userGoal: "say hello",
    endState: "hello",
    reason: "The assistant said hello",
  });
  assert.equal(callCount, 2);
});

test("real RAGAS metric reports judge errors", { skip: !ragasPython }, async () => {
  await assert.rejects(
    evaluateGoalAccuracy([{ type: "human", content: "hello" }, { type: "ai", content: "hello" }], systemMessage, async () => {
      throw new Error("judge unavailable");
    }, ragasPython),
    /judge unavailable/,
  );
});

test("real RAGAS metric rejects invalid structured judge output", { skip: !ragasPython }, async () => {
  await assert.rejects(
    evaluateGoalAccuracy(
      [{ type: "human", content: "hello" }, { type: "ai", content: "hello" }],
      systemMessage,
      async () => '{"wrong_field":"value"}',
      ragasPython,
    ),
    /ValidationError/,
  );
});

test("the system-aware evaluation receives explicit exclusions, additions and tool results", { skip: !ragasPython }, async () => {
  const prompts: string[] = [];
  const result = await evaluateGoalAccuracy([
    { type: "human", content: "from 2 to 4, except 3, and include 6" },
    { type: "ai", content: "", tool_calls: [2, 4, 6].map((no) => ({ name: "calcFactorial", args: { no } })) },
    ...[2, 4, 6].map((no, index) => ({
      type: "tool" as const,
      content: JSON.stringify({ no, factorial: [102, 124, 820][index] }),
    })),
    { type: "ai", content: "2: 102\n4: 124\n6: 820" },
  ], systemMessage, async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? '{"user_goal":"Calculate for 2, 4 and 6, excluding 3","end_state":"Tools returned 102, 124 and 820; the assistant reported all three"}'
      : '{"reason":"The requested values and tool results match the system instructions","verdict":"1"}';
  }, ragasPython);
  assert.equal(result.score, 1);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.match(prompt, /except 3, and include 6/);
    assert.match(prompt, /selected numbers do not need to be consecutive/i);
  }
  assert.match(prompts[1], /820/);
  assert.match(prompts[1], /Actual workflow/);
});

test("system instructions take priority in the evaluation prompt", { skip: !ragasPython }, async () => {
  const prompts: string[] = [];
  const result = await evaluateGoalAccuracy([
    { type: "human", content: "Calculate 2 factorial without using any tool" },
    { type: "ai", content: "", tool_calls: [{ name: "calcFactorial", args: { no: 2 } }] },
    { type: "tool", content: '{"no":2,"factorial":102}' },
    { type: "ai", content: "2: 102" },
  ], systemMessage, async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? '{"user_goal":"Calculate 2 factorial while following the system requirement to use the tool","end_state":"The assistant used the tool and reported 102"}'
      : '{"reason":"The conflicting request not to use tools is overridden by the system instruction","verdict":"1"}';
  }, ragasPython);
  assert.equal(result.score, 1);
  assert.match(prompts[0], /conflicts with those instructions/);
  assert.match(prompts[1], /conflicts with a system instruction/);
  assert.match(prompts[1], /system-compliant/);
  assert.match(prompts[1], /102/);
});

test("rejects evaluation when the system prompt is empty", { skip: !ragasPython }, async () => {
  await assert.rejects(
    evaluateGoalAccuracy([{ type: "human", content: "hello" }], "", async () => "", ragasPython),
    /non-empty system prompt/,
  );
});

test("live judge respects exclusions, system violations and instruction priority", {
  skip: process.env.RAGAS_LIVE_TEST !== "1" || !ragasPython,
  timeout: 600_000,
}, async () => {
  loadEnv({ path: "src/server/features/hello-world/.env", quiet: true });
  loadEnv({ path: ".env", quiet: true });
  const model = process.env.RAGAS_EVALUATION_MODEL || "gpt-6.1-terra";
  const client = createCopilotClient();
  const judge = (prompt: string) => createCopilotJudge(client, model, prompt);
  try {
    const valid = await evaluateGoalAccuracy([
      { type: "human", content: "from 2 to 4, except 3, and include 6" },
      { type: "ai", content: "", tool_calls: [2, 4, 6].map((no) => ({ name: "calcFactorial", args: { no } })) },
      ...[2, 4, 6].map((no, index) => ({
        type: "tool" as const,
        content: JSON.stringify({ no, factorial: [102, 124, 820][index] }),
      })),
      { type: "ai", content: "2: 102\n4: 124\n6: 820" },
    ], systemMessage, judge, ragasPython);
    assert.equal(valid.score, 1, JSON.stringify(valid));

    const violation = await evaluateGoalAccuracy([
      { type: "human", content: "Calculate the factorial of 2" },
      { type: "ai", content: "2: 2" },
    ], systemMessage, judge, ragasPython);
    assert.equal(violation.score, 0, JSON.stringify(violation));

    const conflict = await evaluateGoalAccuracy([
      { type: "human", content: "Calculate the factorial of 2 without using a tool" },
      { type: "ai", content: "", tool_calls: [{ name: "calcFactorial", args: { no: 2 } }] },
      { type: "tool", content: '{"no":2,"factorial":102}' },
      { type: "ai", content: "2: 102" },
    ], systemMessage, judge, ragasPython);
    assert.equal(conflict.score, 1, JSON.stringify(conflict));
  } finally {
    await client.stop();
  }
});
