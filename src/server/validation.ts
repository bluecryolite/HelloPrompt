export type NumericValue = number | string;
export type Step = { operation: string; result: NumericValue; remaining: NumericValue[] };
export type Solution = { expression: string; formattedExpression: string; steps: Step[] };
type Fraction = { n: bigint; d: bigint };
type Parsed = { value: Fraction; literals: Fraction[] };
type Node = { value: Fraction; expression: string };

const TARGET = { n: 24n, d: 1n };
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
const fraction = (n: bigint, d = 1n): Fraction => {
  if (!d) throw new Error("算式不能除以零。");
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
};
const same = (a: Fraction, b: Fraction) => a.n === b.n && a.d === b.d;
const asNumber = (value: Fraction) => Number(value.n) / Number(value.d);
const fromValue = (value: NumericValue): Fraction => {
  if (typeof value === "string" && /^-?\d+\/\d+$/.test(value)) {
    const [numerator, denominator] = value.split("/").map(BigInt);
    return fraction(numerator, denominator);
  }
  if (typeof value !== "number" && !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("步骤结果必须是数字或精确分数。");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("步骤结果必须是有限数字。");
  const text = String(value);
  if (!text.includes("e")) {
    const [whole, decimal = ""] = text.split(".");
    return fraction(BigInt(`${whole}${decimal}`), 10n ** BigInt(decimal.length));
  }
  const [mantissa, exponentText] = text.split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  const places = (mantissa.split(".")[1]?.length ?? 0) - exponent;
  return places >= 0 ? fraction(BigInt(digits), 10n ** BigInt(places)) : fraction(BigInt(digits) * 10n ** BigInt(-places));
};
const sameList = (left: Fraction[], right: Fraction[]) => {
  const remaining = [...right];
  return left.every((value) => {
    const index = remaining.findIndex((candidate) => same(value, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  }) && remaining.length === 0;
};

export function validateNumbers(input: unknown): number[] {
  if (!Array.isArray(input) || input.length !== 4 ||
      input.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10)) {
    throw Object.assign(new Error("请输入四个 1 到 10 之间的整数。"), { code: "INPUT" });
  }
  return input;
}

function calculate(left: Fraction, operator: string, right: Fraction): Fraction {
  if (operator === "+") return fraction(left.n * right.d + right.n * left.d, left.d * right.d);
  if (operator === "-") return fraction(left.n * right.d - right.n * left.d, left.d * right.d);
  if (operator === "*") return fraction(left.n * right.n, left.d * right.d);
  if (!right.n) throw new Error("算式不能除以零。");
  return fraction(left.n * right.d, left.d * right.n);
}

function parseExpression(expression: string, allowDecimals = false): Parsed {
  const literalPattern = allowDecimals ? "\\d+(?:\\.\\d+)?" : "\\d+";
  const referencePattern = allowDecimals ? "\\{-?(?:\\d+(?:\\.\\d+)?|\\d+/\\d+)\\}" : "(?!)";
  const tokenPattern = new RegExp(`(?:${referencePattern}|${literalPattern}|[()+\\-*/])`, "g");
  if (typeof expression !== "string" || !/^[\d.+\-*/(){}\s]+$/.test(expression)) throw new Error("算式格式无效。");
  const tokens = expression.match(tokenPattern) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "")) throw new Error("算式格式无效。");
  let position = 0;
  const primary = (): Parsed => {
    if (allowDecimals && (tokens[position] === "+" || tokens[position] === "-")) {
      const negative = tokens[position++] === "-";
      const result = primary();
      if (result.literals.length !== 1) throw new Error("一元符号只能用于单个数字。");
      return negative ? { value: fraction(-result.value.n, result.value.d), literals: [fraction(-result.literals[0].n, result.literals[0].d)] } : result;
    }
    if (tokens[position] === "(") {
      position++;
      const result = additive();
      if (tokens[position++] !== ")") throw new Error("括号不匹配。");
      return result;
    }
    const token = tokens[position++];
    if (!token) throw new Error("算式语法无效。");
    if (token.startsWith("{") && token.endsWith("}")) {
      const value = fromValue(token.slice(1, -1));
      return { value, literals: [value] };
    }
    if (!new RegExp(`^${literalPattern}$`).test(token)) throw new Error("算式语法无效。");
    const [whole, decimal = ""] = token.split(".");
    return { value: fraction(BigInt(`${whole}${decimal}`), 10n ** BigInt(decimal.length)), literals: [fraction(BigInt(`${whole}${decimal}`), 10n ** BigInt(decimal.length))] };
  };
  const multiplicative = (): Parsed => {
    let result = primary();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++], right = primary();
      result = { value: calculate(result.value, operator, right.value), literals: [...result.literals, ...right.literals] };
    }
    return result;
  };
  function additive(): Parsed {
    let result = multiplicative();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++], right = multiplicative();
      result = { value: calculate(result.value, operator, right.value), literals: [...result.literals, ...right.literals] };
    }
    return result;
  }
  const result = additive();
  if (position !== tokens.length) throw new Error("算式语法无效。");
  return result;
}

export function evaluateExpression(expression: string): number {
  return asNumber(parseExpression(expression).value);
}

export function evaluateStepExpression(expression: string): number {
  return asNumber(parseExpression(expression, true).value);
}

function validateSteps(numbers: number[], rawSteps: unknown): Step[] {
  if (!Array.isArray(rawSteps) || rawSteps.length !== 3) throw new Error("模型返回的步骤无效。");
  let remaining = numbers.map((value) => fraction(BigInt(value)));
  return rawSteps.map((raw) => {
    if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join(",") !== "operation,remaining,result") throw new Error("模型返回的步骤结构无效。");
    const item = raw as Record<string, unknown>;
    if (typeof item.operation !== "string" || (typeof item.result !== "number" && typeof item.result !== "string") || !Array.isArray(item.remaining) ||
        item.remaining.some((value) => (typeof value !== "number" && typeof value !== "string") || (typeof value === "number" && !Number.isFinite(value)))) throw new Error("模型返回的步骤值无效。");
    const operation = parseExpression(item.operation, true);
    if (operation.literals.length !== 2 || !sameList(operation.literals, remaining) && !operation.literals.every((value) => remaining.some((candidate) => same(value, candidate)))) {
      throw new Error("模型返回的步骤与当前数字不一致。");
    }
    const resultValue = fromValue(item.result);
    if (!same(operation.value, resultValue)) throw new Error("模型返回的步骤结果无效。");
    const next = [...remaining];
    for (const literal of operation.literals) {
      const index = next.findIndex((candidate) => same(candidate, literal));
      if (index < 0) throw new Error("模型返回的步骤与当前数字不一致。");
      next.splice(index, 1);
    }
    next.push(resultValue);
    const expected = (item.remaining as NumericValue[]).map((value) => fromValue(value));
    if (!sameList(next, expected)) throw new Error("模型返回的剩余数字无效。");
    remaining = next;
    return { operation: item.operation, result: item.result, remaining: item.remaining as NumericValue[] };
  });
}

function search(nodes: Node[]): { expression: string; steps: Step[] } | null {
  if (nodes.length === 1) return same(nodes[0].value, TARGET) ? { expression: nodes[0].expression, steps: [] } : null;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j], rest = nodes.filter((_, index) => index !== i && index !== j);
    const candidates: Array<[Fraction, string]> = [[calculate(a.value, "+", b.value), `${a.expression} + ${b.expression}`], [calculate(a.value, "-", b.value), `${a.expression} - ${b.expression}`], [calculate(b.value, "-", a.value), `${b.expression} - ${a.expression}`], [calculate(a.value, "*", b.value), `${a.expression} * ${b.expression}`]];
    if (b.value.n) candidates.push([calculate(a.value, "/", b.value), `${a.expression} / ${b.expression}`]);
    if (a.value.n) candidates.push([calculate(b.value, "/", a.value), `${b.expression} / ${a.expression}`]);
    for (const [value, operation] of candidates) {
      const result = search([...rest, { value, expression: `(${operation})` }]);
      if (result) return { expression: result.expression, steps: [{ operation, result: asNumber(value), remaining: [...rest.map((node) => asNumber(node.value)), asNumber(value)] }, ...result.steps] };
    }
  }
  return null;
}

export function findLocalSolution(numbers: number[]): Solution | null {
  const result = search(numbers.map((value) => ({ value: fraction(BigInt(value)), expression: String(value) })));
  return result ? { expression: result.expression, formattedExpression: `${result.expression} = 24`, steps: result.steps } : null;
}

export function validateSolution(numbers: number[], expression: unknown, steps: unknown): Solution {
  const parsed = parseExpression(expression as string);
  if (!sameList(parsed.literals, numbers.map((value) => fraction(BigInt(value)))) || !same(parsed.value, TARGET)) throw new Error("算式必须恰好使用输入数字各一次且结果为 24。");
  return { expression: expression as string, formattedExpression: `${expression} = 24`, steps: validateSteps(numbers, steps) };
}
