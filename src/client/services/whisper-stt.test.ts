import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodePcm16Wav,
  MAX_RECORDING_MS,
  WhisperSttService,
  type MediaRecorderLike,
  type MediaStreamLike,
  type Transcriber,
} from "./whisper-stt.js";

class FakeRuntime implements Transcriber {
  loadCalls = 0;
  transcribeCalls: Float32Array[] = [];
  transcript = "hello from the microphone";

  async load(): Promise<void> {
    this.loadCalls += 1;
  }

  async transcribe(audio: Float32Array): Promise<string> {
    this.transcribeCalls.push(audio);
    return this.transcript;
  }

  dispose(): void {}
}

class FakeTrack {
  stopCalls = 0;

  stop(): void {
    this.stopCalls += 1;
  }
}

class FakeStream implements MediaStreamLike {
  readonly track = new FakeTrack();

  getTracks(): Array<FakeTrack> {
    return [this.track];
  }
}

class FakeRecorder implements MediaRecorderLike {
  state = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({
        data: new Blob(["recorded audio"], { type: "audio/webm" }),
      } as BlobEvent);
      this.onstop?.();
    });
  }
}

function createClock() {
  const timeoutHandlers: Array<() => void> = [];
  const intervalHandlers: Array<() => void> = [];
  return {
    timeoutHandlers,
    intervalHandlers,
    setTimeout(handler: () => void): ReturnType<typeof setTimeout> {
      timeoutHandlers.push(handler);
      return timeoutHandlers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(): void {},
    setInterval(handler: () => void): ReturnType<typeof setInterval> {
      intervalHandlers.push(handler);
      return intervalHandlers.length as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(): void {},
  };
}

function createSpeechAudio(): Float32Array {
  const audio = new Float32Array(16_000);
  for (let index = 4_800; index < 8_000; index += 1) {
    audio[index] = index % 2 === 0 ? 0.2 : -0.2;
  }
  return audio;
}

test("encodes Whisper audio as mono 16 kHz PCM WAV", async () => {
  const wav = encodePcm16Wav(new Float32Array([-1, 0, 1]));
  const view = new DataView(await wav.arrayBuffer());

  assert.equal(wav.type, "audio/wav");
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32_768);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 32_767);
});

test("preloads Whisper once and shares the ready state", async () => {
  const runtime = new FakeRuntime();
  const service = new WhisperSttService({
    runtimeFactory: () => runtime,
    device: "webgpu",
  });

  await Promise.all([service.load(), service.load()]);

  assert.equal(runtime.loadCalls, 1);
  assert.equal(service.state.state, "ready");
  assert.equal(service.state.device, "webgpu");
  service.dispose();
});

test("stops recording, transcribes audio, and releases the microphone stream", async () => {
  const runtime = new FakeRuntime();
  const stream = new FakeStream();
  const recorder = new FakeRecorder();
  const service = new WhisperSttService({
    runtimeFactory: () => runtime,
    device: "wasm",
    mimeType: "audio/webm",
    getUserMedia: async () => stream,
    mediaRecorderFactory: () => recorder,
    decodeAudio: async (blob) => {
      assert.ok(blob.size > 0);
      assert.equal(blob.type, "audio/webm");
      return createSpeechAudio();
    },
    clock: createClock(),
  });
  const transcripts: string[] = [];
  service.onTranscript((transcript) => transcripts.push(transcript));

  await service.startRecording();
  await service.stopRecording();

  assert.deepEqual(transcripts, ["hello from the microphone"]);
  assert.equal(runtime.transcribeCalls.length, 1);
  const transcribedAudio = runtime.transcribeCalls[0];
  assert.ok(transcribedAudio);
  assert.ok(transcribedAudio.length < 16_000);
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(service.state.state, "ready");
  service.dispose();
});

test("rejects silent recordings without invoking Whisper", async () => {
  const runtime = new FakeRuntime();
  const stream = new FakeStream();
  const service = new WhisperSttService({
    runtimeFactory: () => runtime,
    mimeType: "audio/webm",
    getUserMedia: async () => stream,
    mediaRecorderFactory: () => new FakeRecorder(),
    decodeAudio: async () => new Float32Array(16_000),
    clock: createClock(),
  });

  await service.startRecording();
  await assert.rejects(service.stopRecording(), /未检测到清晰语音/);

  assert.equal(runtime.transcribeCalls.length, 0);
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(service.state.state, "error");
  service.dispose();
});

test("accepts a natural-length transcript for a short recording", async () => {
  const runtime = new FakeRuntime();
  runtime.transcript = "Please help me find a place to eat nearby today.";
  const transcripts: string[] = [];
  const service = new WhisperSttService({
    runtimeFactory: () => runtime,
    mimeType: "audio/webm",
    getUserMedia: async () => new FakeStream(),
    mediaRecorderFactory: () => new FakeRecorder(),
    decodeAudio: async () => createSpeechAudio(),
    clock: createClock(),
  });
  service.onTranscript((transcript) => transcripts.push(transcript));

  await service.startRecording();
  await service.stopRecording();

  assert.deepEqual(transcripts, [runtime.transcript]);
  assert.equal(service.state.state, "ready");
  service.dispose();
});

test("allows another recording after audio decoding fails", async () => {
  const runtime = new FakeRuntime();
  const stream = new FakeStream();
  const recorder = new FakeRecorder();
  const service = new WhisperSttService({
    runtimeFactory: () => runtime,
    mimeType: "audio/webm",
    getUserMedia: async () => stream,
    mediaRecorderFactory: () => recorder,
    decodeAudio: async () => {
      throw new Error("Unable to decode audio data");
    },
    clock: createClock(),
  });

  await service.startRecording();
  await assert.rejects(service.stopRecording(), /Unable to decode audio data/);
  assert.equal(service.state.state, "error");

  await service.startRecording();

  assert.equal(service.state.state, "recording");
  assert.equal(runtime.loadCalls, 1);
  service.dispose();
});

test("automatically stops and transcribes at the twenty-second limit", async () => {
  const runtime = new FakeRuntime();
  const stream = new FakeStream();
  const recorder = new FakeRecorder();
  const clock = createClock();
  const service = new WhisperSttService({
    runtimeFactory: () => runtime,
    mimeType: "audio/webm",
    getUserMedia: async () => stream,
    mediaRecorderFactory: () => recorder,
    decodeAudio: async () => createSpeechAudio(),
    clock,
  });
  const transcripts: string[] = [];
  service.onTranscript((transcript) => transcripts.push(transcript));

  await service.startRecording();
  assert.equal(service.state.maxRecordingMs, MAX_RECORDING_MS);
  assert.equal(clock.timeoutHandlers.length, 1);
  clock.timeoutHandlers[0]?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(transcripts, ["hello from the microphone"]);
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(service.state.state, "ready");
  service.dispose();
});
