import assert from "node:assert/strict";
import { test } from "node:test";
import { MeloTtsService, selectSpeechText, type AudioPlayer, type AudioSamples, type MeloTtsRuntime } from "./melo-tts.js";

class FakeRuntime implements MeloTtsRuntime {
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
    return Promise.resolve({ samples: new Float32Array([0, 0.1]), sampleRate: 44100 });
  }

  dispose(): void {}
}

class FakePlayer implements AudioPlayer {
  playCalls: AudioSamples[] = [];
  stopCalls = 0;
  resolvePlayback?: () => void;

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
}

test("speech selection uses only message text", () => {
  assert.equal(selectSpeechText({
    text: "这是回复正文",
    response: { model: "secret metadata", elapsedMs: 1000 },
  }), "这是回复正文");
});

test("loading is shared and the latest speech replaces an older request", async () => {
  const runtime = new FakeRuntime();
  const player = new FakePlayer(true);
  const service = new MeloTtsService({ runtimeFactory: () => runtime, player });
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
  const service = new MeloTtsService({ runtimeFactory: () => runtime, player });
  const speaking = service.speak("可取消的回复");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  service.stop();
  await speaking;

  assert.equal(service.state.state, "ready");
  assert.equal(player.stopCalls > 0, true);
  service.dispose();
});
