import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExpression, evaluateStepExpression, findLocalSolution, validateNumbers, validateSolution } from "./validation.js";

test("evaluates multiplication before addition", () => {
  assert.equal(evaluateExpression("1 + 2 * 3"), 7);
});

test("validates a solution and its auditable steps", () => {
  const steps = [
    { operation: "1 * 2", result: 2, remaining: [3, 4, 2] },
    { operation: "2 * 3", result: 6, remaining: [4, 6] },
    { operation: "6 * 4", result: 24, remaining: [24] }
  ];
  assert.equal(validateSolution([1, 2, 3, 4], "1 * 2 * 3 * 4", steps).formattedExpression, "1 * 2 * 3 * 4 = 24");
});

test("rejects duplicated or invalid inputs", () => {
  assert.throws(() => validateNumbers([0, 2, 3, 4]), /1 到 10/);
  assert.throws(() => validateSolution([1, 2, 3, 4], "1 + 2 + 3 + 4", []), /24/);
  assert.throws(() => validateSolution([1, 2, 3, 4], "1 * 2 * 3 * 4", [
    { operation: "1 * 2", result: 2, remaining: [2, 3, 4], extra: true },
    { operation: "2 * 3", result: 6, remaining: [4, 6] },
    { operation: "6 * 4", result: 24, remaining: [24] }
  ]), /步骤/);
});

test("identifies unsolvable numbers", () => {
  assert.equal(findLocalSolution([1, 1, 1, 1]), null);
});

test("accepts exact fraction values in auditable steps", () => {
  const steps = [
    { operation: "3 / 4", result: "3/4", remaining: [1, 6, "3/4"] },
    { operation: "1 - {3/4}", result: "1/4", remaining: [6, "1/4"] },
    { operation: "6 / {1/4}", result: 24, remaining: [24] }
  ];
  assert.equal(validateSolution([1, 3, 4, 6], "6 / (1 - 3 / 4)", steps).formattedExpression, "6 / (1 - 3 / 4) = 24");
});

test("accepts negative intermediate operands", () => {
  assert.equal(evaluateStepExpression("-1 * 24"), -24);
  assert.equal(evaluateStepExpression("{-1} * 24"), -24);
});
