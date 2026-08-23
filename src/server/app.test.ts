import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { app, toErrorResponse } from "./app.js";

test("returns JSON for malformed request bodies", async () => {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/solve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{\"numbers\":"
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: "INVALID_JSON", message: "请求 JSON 格式无效。" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("maps upstream and request failures to the API contract", () => {
  assert.equal(toErrorResponse(Object.assign(new Error("timeout"), { code: "TIMEOUT" })).status, 504);
  assert.equal(toErrorResponse(Object.assign(new Error("bad model"), { code: "MODEL_OUTPUT" })).body.code, "MODEL_OUTPUT_INVALID");
  assert.equal(toErrorResponse(Object.assign(new Error("limited"), { code: "RATE_LIMIT" })).status, 429);
  assert.equal(toErrorResponse(Object.assign(new Error("none"), { code: "NO_SOLUTION" })).body.code, "NO_SOLUTION");
});
