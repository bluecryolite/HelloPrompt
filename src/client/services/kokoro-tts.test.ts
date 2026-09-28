import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KokoroTtsService,
  selectSpeechText,
  splitSpeechText,
  type AudioPlayer,
  type AudioSamples,
  type KokoroTtsRuntime,
} from "./kokoro-tts.js";

class FakeRuntime implements KokoroTtsRuntime {
  loadCalls = 0;
  synthesizeCalls: string[] = [];
  resolveLoad?: () => void;
  private loaded = false;

  load(): Promise<void> {
    this.loadCalls += 1;
    if (this.resolveLoad) {
      return new Promise<void>((resolve) => {
        this.resolveLoad = () => {
          this.loaded = true;
          resolve();
        };
      });
    }
    this.loaded = true;
    return Promise.resolve();
  }

  synthesize(text: string): Promise<AudioSamples> {
    assert.equal(this.loaded, true);
    this.synthesizeCalls.push(text);
    return Promise.resolve({ samples: new Float32Array([0, 0.1]), sampleRate: 24_000 });
  }

  dispose(): void {}
}

class FakePlayer implements AudioPlayer {
  playCalls: AudioSamples[] = [];
  stopCalls = 0;

  constructor(private readonly autoFinish = false) {}

  prime(): void {}

  play(audio: AudioSamples): Promise<void> {
    this.playCalls.push(audio);
    if (this.autoFinish) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolvePlayback = resolve;
    });
  }

  stop(): void {
    this.stopCalls += 1;
    this.resolvePlayback?.();
    this.resolvePlayback = undefined;
  }

  dispose(): void {}

  private resolvePlayback?: () => void;
}

test("speech selection uses only message text", () => {
  assert.equal(selectSpeechText({
    text: "这是回复正文",
    response: { model: "secret metadata", elapsedMs: 1000 },
  }), "这是回复正文");
});

test("speech text is split at sentence boundaries and long clauses", () => {
  assert.deepEqual(splitSpeechText(
    "Thanks, Marco. Training is starting.\nThe players are Alex and Ben.",
  ), ["Thanks,", "Marco.", "Training is starting.", "The players are Alex and Ben."]);

  const longSentence = `Alex is serving, ${"and the score is three ".repeat(12)}the rally continues.`;
  const chunks = splitSpeechText(longSentence);
  assert.equal(chunks.every((chunk) => chunk.length <= 180), true);
  assert.equal(chunks.join(" ").replace(/\s+/gu, " "), longSentence.replace(/\s+/gu, " "));
});

test("commas, colons, and dashes create short-pause audio boundaries", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer(true);
  const service = new KokoroTtsService({ runtimeFactory: () => runtime, player });

  await service.speak("Hello, there: wait—well-known.");

  assert.deepEqual(runtime.synthesizeCalls, ["Hello,", "there:", "wait—", "well-", "known."]);
  assert.equal(player.playCalls.length, 1);
  assert.equal(player.playCalls[0]?.samples.length, 5 * 2 + 4 * 4_320);
  service.dispose();
});

test("quotes pause, adjacent pause punctuation coalesces, and asterisks are removed", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer(true);
  const service = new KokoroTtsService({ runtimeFactory: () => runtime, player });

  await service.speak('"Hello,:* world*"');
  await service.speak("***");

  assert.deepEqual(splitSpeechText("say*it"), ["sayit"]);
  assert.deepEqual(runtime.synthesizeCalls, ["Hello,:", "world"]);
  assert.equal(player.playCalls.length, 1);
  assert.equal(player.playCalls[0]?.samples.length, 2 * 2 + 3 * 4_320);
  service.dispose();
});

test("punctuation between digits does not create a pause", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer(true);
  const service = new KokoroTtsService({ runtimeFactory: () => runtime, player });

  await service.speak("Score 5-3, time 12:30, and total 1,000.");
  await service.speak("5\n3");

  assert.deepEqual(runtime.synthesizeCalls, ["Score 5-3,", "time 12:30,", "and total 1,000.", "5 3"]);
  assert.deepEqual(player.playCalls.map(({ samples }) => samples.length), [
    3 * 2 + 2 * 4_320,
    2,
  ]);
  service.dispose();
});

test("sentence chunks are synthesized separately and played as one continuous buffer", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer(true);
  const service = new KokoroTtsService({ runtimeFactory: () => runtime, player });

  await service.speak("Thanks, Marco. Training is starting. The players are Alex and Ben.");

  assert.deepEqual(runtime.synthesizeCalls, [
    "Thanks,",
    "Marco.",
    "Training is starting.",
    "The players are Alex and Ben.",
  ]);
  assert.equal(player.playCalls.length, 1);
  assert.equal(player.playCalls[0]?.samples.length, 4 * 2 + 3 * 4_320);
  service.dispose();
});

test("loading is shared and the latest speech replaces an older request", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer(true);
  const service = new KokoroTtsService({ runtimeFactory: () => runtime, player });
  const states: string[] = [];
  service.subscribe(({ state }) => states.push(state));

  const first = service.speak("第一条");
  const second = service.speak("第二条");
  await Promise.all([first, second]);

  assert.equal(runtime.loadCalls, 1);
  assert.deepEqual(runtime.synthesizeCalls, ["第二条"]);
  assert.equal(player.playCalls.length, 1);
  assert.equal(states.includes("loading"), true);
  service.dispose();
});

test("stop cancels playback without leaving a speaking state", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer();
  const service = new KokoroTtsService({ runtimeFactory: () => runtime, player });
  const speaking = service.speak("可取消的回复");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  service.stop();
  await speaking;

  assert.equal(service.state.state, "ready");
  assert.equal(player.stopCalls > 0, true);
  service.dispose();
});
