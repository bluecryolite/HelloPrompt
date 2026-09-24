import assert from "node:assert/strict";
import { test } from "node:test";
import {
  withTransformersLocalModelPath,
  type TransformersEnvironment,
} from "./transformers-model-loader.js";

function createEnvironment(): TransformersEnvironment {
  return {
    allowLocalModels: false,
    allowRemoteModels: true,
    localModelPath: "/models/",
  };
}

test("serializes model loads while each local model path is active", async () => {
  const env = createEnvironment();
  const events: string[] = [];
  let releaseWhisperLoad!: () => void;
  const whisperLoadGate = new Promise<void>((resolve) => {
    releaseWhisperLoad = resolve;
  });

  const whisperLoad = withTransformersLocalModelPath(env, "/models/whisper/", async () => {
    events.push(`whisper:start:${env.localModelPath}`);
    await whisperLoadGate;
    events.push(`whisper:end:${env.localModelPath}`);
  });
  const kokoroLoad = withTransformersLocalModelPath(env, "/models/kokoro/", async () => {
    events.push(`kokoro:${env.localModelPath}`);
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["whisper:start:/models/whisper/"]);
  releaseWhisperLoad();
  await Promise.all([whisperLoad, kokoroLoad]);

  assert.deepEqual(events, [
    "whisper:start:/models/whisper/",
    "whisper:end:/models/whisper/",
    "kokoro:/models/kokoro/",
  ]);
  assert.equal(env.localModelPath, "/models/");
  assert.equal(env.allowLocalModels, true);
  assert.equal(env.allowRemoteModels, false);
});

test("continues queued model loads after a load fails", async () => {
  const env = createEnvironment();

  await assert.rejects(
    withTransformersLocalModelPath(env, "/models/whisper/", async () => {
      throw new Error("model load failed");
    }),
    /model load failed/,
  );

  let activeModelPath = "";
  await withTransformersLocalModelPath(env, "/models/kokoro/", async () => {
    activeModelPath = env.localModelPath;
  });

  assert.equal(activeModelPath, "/models/kokoro/");
  assert.equal(env.localModelPath, "/models/");
});
