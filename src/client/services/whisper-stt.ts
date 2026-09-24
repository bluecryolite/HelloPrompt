import type {
  AutomaticSpeechRecognitionPipelineType,
  AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import { withTransformersLocalModelPath } from "./transformers-model-loader.js";

export const MAX_RECORDING_MS = 20_000;
const TARGET_SAMPLE_RATE = 16_000;
const AUDIO_FRAME_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.02);
const MIN_ACTIVE_FRAME_RMS = 0.006;
const RELATIVE_ACTIVITY_THRESHOLD = 0.1;
const MIN_SPEECH_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.08);
const SILENCE_PADDING_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.12);
const MIN_TRANSCRIPT_TOKENS = 24;
const MAX_TRANSCRIPT_TOKENS = 96;

export type SttDevice = "wasm" | "webgpu";
export type SttState = "idle" | "loading" | "ready" | "recording" | "transcribing" | "error";

export type SttSnapshot = {
  state: SttState;
  device: SttDevice;
  elapsedMs: number;
  maxRecordingMs: number;
  error?: Error;
};

export type Transcriber = {
  load(): Promise<SttDevice | void>;
  transcribe(audio: Float32Array): Promise<string>;
  dispose(): void;
};

export type MediaRecorderLike = {
  state: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
};

export type MediaStreamLike = {
  getTracks(): Array<{ stop(): void }>;
};

export type WhisperSttConfig = {
  assetBaseUrl?: string;
  modelId?: string;
  dtype?: "q8" | "q4" | "q4f16" | "fp16" | "fp32";
  device?: SttDevice;
  mimeType?: string;
  runtimeFactory?: () => Transcriber;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  mediaRecorderFactory?: (stream: MediaStreamLike, mimeType: string) => MediaRecorderLike;
  decodeAudio?: (blob: Blob) => Promise<Float32Array>;
  clock?: {
    setTimeout(handler: () => void, timeout: number): ReturnType<typeof setTimeout>;
    clearTimeout(timeoutId: ReturnType<typeof setTimeout>): void;
    setInterval(handler: () => void, timeout: number): ReturnType<typeof setInterval>;
    clearInterval(intervalId: ReturnType<typeof setInterval>): void;
  };
};

type Listener = (snapshot: SttSnapshot) => void;
type TranscriptListener = (transcript: string) => void;
type RuntimePipeline = AutomaticSpeechRecognitionPipelineType;

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const DEFAULT_ASSET_BASE_URL = env.VITE_WHISPER_ASSET_BASE_URL ?? "/models/whisper/";
const DEFAULT_MODEL_ID = env.VITE_WHISPER_MODEL_ID ?? "Xenova/whisper-small.en";
const DEFAULT_DTYPE = parseDtype(env.VITE_WHISPER_DTYPE);

function parseDtype(value: string | undefined): NonNullable<WhisperSttConfig["dtype"]> {
  switch (value) {
    case "q8":
    case "q4":
    case "q4f16":
    case "fp16":
    case "fp32":
      return value;
    default:
      return "q8";
  }
}

function browserSupportsWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

function isWebGpuApi(value: unknown): value is { requestAdapter(): Promise<unknown> } {
  return typeof value === "object" &&
    value !== null &&
    "requestAdapter" in value &&
    typeof value.requestAdapter === "function";
}

async function hasWebGpuAdapter(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  const gpu = "gpu" in navigator ? navigator.gpu : undefined;
  if (!isWebGpuApi(gpu)) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function downloadRecording(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function encodePcm16Wav(audio: Float32Array): Blob {
  const bytesPerSample = 2;
  const dataSize = audio.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index] ?? 0));
    const pcmSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(44 + index * bytesPerSample, Math.round(pcmSample), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function trimSilence(audio: Float32Array): Float32Array {
  const frameLevels: number[] = [];
  let peakFrameRms = 0;

  for (let start = 0; start < audio.length; start += AUDIO_FRAME_SAMPLES) {
    const end = Math.min(start + AUDIO_FRAME_SAMPLES, audio.length);
    let sum = 0;
    let sumSquares = 0;
    for (let index = start; index < end; index += 1) {
      const sample = audio[index] ?? 0;
      sum += sample;
      sumSquares += sample * sample;
    }
    const count = end - start;
    const mean = sum / count;
    const rms = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
    frameLevels.push(rms);
    peakFrameRms = Math.max(peakFrameRms, rms);
  }

  if (peakFrameRms < MIN_ACTIVE_FRAME_RMS) {
    throw new Error("未检测到清晰语音，请靠近麦克风后重试。");
  }

  const threshold = Math.max(MIN_ACTIVE_FRAME_RMS / 2, peakFrameRms * RELATIVE_ACTIVITY_THRESHOLD);
  const activeFrames: number[] = [];
  let activeSamples = 0;
  for (let frame = 0; frame < frameLevels.length; frame += 1) {
    if ((frameLevels[frame] ?? 0) < threshold) continue;
    activeFrames.push(frame);
    const start = frame * AUDIO_FRAME_SAMPLES;
    activeSamples += Math.min(AUDIO_FRAME_SAMPLES, audio.length - start);
  }
  if (activeSamples < MIN_SPEECH_SAMPLES) {
    throw new Error("未检测到清晰语音，请靠近麦克风后重试。");
  }

  const firstActive = activeFrames[0];
  const lastActive = activeFrames.at(-1);
  if (firstActive === undefined || lastActive === undefined) {
    throw new Error("未检测到清晰语音，请靠近麦克风后重试。");
  }

  const start = Math.max(0, firstActive * AUDIO_FRAME_SAMPLES - SILENCE_PADDING_SAMPLES);
  const end = Math.min(audio.length, (lastActive + 1) * AUDIO_FRAME_SAMPLES + SILENCE_PADDING_SAMPLES);
  return audio.slice(start, end);
}

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("当前浏览器不支持录音。");
  }
  for (const mimeType of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  throw new Error("当前浏览器没有可用的录音格式。");
}

function createBrowserMediaRecorder(stream: MediaStreamLike, mimeType: string): MediaRecorderLike {
  if (typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持录音。");
  const recorder = new MediaRecorder(stream as MediaStream, { mimeType });
  const adapter: MediaRecorderLike = {
    get state() {
      return recorder.state;
    },
    ondataavailable: null,
    onerror: null,
    onstop: null,
    start: () => recorder.start(),
    stop: () => recorder.stop(),
  };
  recorder.ondataavailable = (event) => adapter.ondataavailable?.(event);
  recorder.onerror = (event) => adapter.onerror?.(event);
  recorder.onstop = () => adapter.onstop?.();
  return adapter;
}

async function decodeAndResample(blob: Blob): Promise<Float32Array> {
  if (typeof AudioContext === "undefined") {
    throw new Error("当前浏览器不支持音频解码。");
  }
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const frameCount = Math.max(1, Math.round(buffer.duration * TARGET_SAMPLE_RATE));
    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const source = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const position = frame * buffer.sampleRate / TARGET_SAMPLE_RATE;
        const lower = Math.floor(position);
        const upper = Math.min(lower + 1, source.length - 1);
        const weight = position - lower;
        mono[frame] += (source[lower] ?? 0) * (1 - weight) + (source[upper] ?? 0) * weight;
      }
    }
    mono.forEach((_, index) => {
      mono[index] /= buffer.numberOfChannels;
    });
    return mono;
  } finally {
    void context.close();
  }
}

class BrowserWhisperRuntime implements Transcriber {
  private pipeline?: RuntimePipeline;
  private activeDevice: SttDevice;

  constructor(
    private readonly assetBaseUrl: string,
    private readonly modelId: string,
    private readonly dtype: NonNullable<WhisperSttConfig["dtype"]>,
    device: SttDevice,
  ) {
    this.activeDevice = device;
  }

  async load(): Promise<SttDevice> {
    if (this.activeDevice === "webgpu" && !(await hasWebGpuAdapter())) {
      this.activeDevice = "wasm";
    }
    const transformers = await import("@huggingface/transformers");
    const createPipeline = transformers.pipeline as (
      task: "automatic-speech-recognition",
      model: string,
      options: { device: SttDevice; dtype: string; local_files_only: boolean },
    ) => Promise<RuntimePipeline>;
    this.pipeline = await withTransformersLocalModelPath(
      transformers.env,
      this.assetBaseUrl,
      async () => {
        try {
          return await createPipeline("automatic-speech-recognition", this.modelId, {
            device: this.activeDevice,
            dtype: this.dtype,
            local_files_only: true,
          });
        } catch (exception) {
          if (this.activeDevice !== "webgpu") throw exception;
          this.activeDevice = "wasm";
          return createPipeline("automatic-speech-recognition", this.modelId, {
            device: this.activeDevice,
            dtype: this.dtype,
            local_files_only: true,
          });
        }
      },
    );
    return this.activeDevice;
  }

  async transcribe(audio: Float32Array): Promise<string> {
    if (!this.pipeline) throw new Error("Whisper 尚未准备完成。");
    const durationSeconds = audio.length / TARGET_SAMPLE_RATE;
    const output = await this.pipeline(audio, {
      chunk_length_s: 20,
      max_new_tokens: Math.min(
        MAX_TRANSCRIPT_TOKENS,
        Math.max(MIN_TRANSCRIPT_TOKENS, Math.ceil(durationSeconds * 10) + 12),
      ),
    });
    const result = Array.isArray(output) ? output[0] : output;
    if (!result || typeof (result as AutomaticSpeechRecognitionOutput).text !== "string") {
      throw new Error("Whisper 返回了无效的转录结果。");
    }
    return (result as AutomaticSpeechRecognitionOutput).text.trim();
  }

  dispose(): void {
    void this.pipeline?.dispose();
    this.pipeline = undefined;
  }
}

export class WhisperSttService {
  private readonly runtime: Transcriber;
  private readonly listeners = new Set<Listener>();
  private readonly transcriptListeners = new Set<TranscriptListener>();
  private readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  private readonly mediaRecorderFactory: (stream: MediaStreamLike, mimeType: string) => MediaRecorderLike;
  private readonly decodeAudio: (blob: Blob) => Promise<Float32Array>;
  private readonly clock: NonNullable<WhisperSttConfig["clock"]>;
  private device: SttDevice;
  private readonly mimeType?: string;
  private runtimeLoaded = false;
  private loadPromise?: Promise<void>;
  private recording?: { recorder: MediaRecorderLike; stream: MediaStreamLike; chunks: Blob[] };
  private recordingTimer?: ReturnType<typeof setTimeout>;
  private progressTimer?: ReturnType<typeof setInterval>;
  private recordingStartedAt?: number;
  private finishPromise?: Promise<string>;
  private requestVersion = 0;
  private disposed = false;
  private snapshot: SttSnapshot;

  constructor(config: WhisperSttConfig = {}) {
    this.device = config.device ?? (browserSupportsWebGpu() ? "webgpu" : "wasm");
    this.mimeType = config.mimeType;
    const assetBaseUrl = config.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL;
    const modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this.runtime = config.runtimeFactory?.() ?? new BrowserWhisperRuntime(
      assetBaseUrl,
      modelId,
      config.dtype ?? DEFAULT_DTYPE,
      this.device,
    );
    this.getUserMedia = config.getUserMedia ?? (async (constraints) => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器无法访问麦克风。");
      return navigator.mediaDevices.getUserMedia(constraints);
    });
    this.mediaRecorderFactory = config.mediaRecorderFactory ?? ((stream, mimeType) => {
      return createBrowserMediaRecorder(stream, mimeType);
    });
    this.decodeAudio = config.decodeAudio ?? decodeAndResample;
    this.clock = config.clock ?? {
      setTimeout: (handler, timeout) => setTimeout(handler, timeout),
      clearTimeout: (timeoutId) => clearTimeout(timeoutId),
      setInterval: (handler, timeout) => setInterval(handler, timeout),
      clearInterval: (intervalId) => clearInterval(intervalId),
    };
    this.snapshot = {
      state: "idle",
      device: this.device,
      elapsedMs: 0,
      maxRecordingMs: MAX_RECORDING_MS,
    };
  }

  get state(): SttSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  onTranscript(listener: TranscriptListener): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Whisper 服务已关闭。"));
    if (this.runtimeLoaded) {
      if (this.snapshot.state === "error") this.setSnapshot({ state: "ready", elapsedMs: 0 });
      return Promise.resolve();
    }
    if (this.snapshot.state === "ready" || this.snapshot.state === "recording" || this.snapshot.state === "transcribing") {
      return Promise.resolve();
    }
    if (this.loadPromise) return this.loadPromise;
    this.setSnapshot({ state: "loading", elapsedMs: 0 });
    this.loadPromise = this.runtime.load()
      .then((device) => {
        this.runtimeLoaded = true;
        if (device) this.device = device;
        this.setSnapshot({ state: "ready", elapsedMs: 0 });
      })
      .catch((exception: unknown) => {
        const error = toError(exception, "Whisper 初始化失败。");
        this.setSnapshot({ state: "error", elapsedMs: 0, error });
        throw error;
      })
      .finally(() => {
        this.loadPromise = undefined;
      });
    return this.loadPromise;
  }

  async startRecording(): Promise<void> {
    if (this.disposed) throw new Error("Whisper 服务已关闭。");
    if (this.recording) return;
    if (this.finishPromise) await this.finishPromise.catch(() => undefined);
    await this.load();
    if (this.disposed) throw new Error("Whisper 服务已关闭。");
    let stream: MediaStreamLike;
    try {
      stream = await this.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (exception) {
      const error = toError(exception, "无法访问麦克风。");
      this.setSnapshot({ state: "error", elapsedMs: 0, error });
      throw error;
    }
    try {
      const mimeType = this.mimeType ?? pickMimeType();
      const recorder = this.mediaRecorderFactory(stream, mimeType);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        this.releaseStream(stream);
        this.recording = undefined;
        this.clearRecordingTimer();
        this.setSnapshot({ state: "error", elapsedMs: 0, error: new Error("录音过程中发生错误。") });
      };
      recorder.onstop = () => undefined;
      recorder.start();
      this.recording = { recorder, stream, chunks };
      this.recordingStartedAt = Date.now();
      this.setSnapshot({ state: "recording", elapsedMs: 0 });
      this.progressTimer = this.clock.setInterval(() => {
        if (!this.recordingStartedAt) return;
        this.setSnapshot({
          state: "recording",
          elapsedMs: Math.min(MAX_RECORDING_MS, Date.now() - this.recordingStartedAt),
        });
      }, 100);
      this.recordingTimer = this.clock.setTimeout(() => {
        void this.finishRecording();
      }, MAX_RECORDING_MS);
    } catch (exception) {
      this.releaseStream(stream);
      const error = toError(exception, "录音启动失败。");
      this.setSnapshot({ state: "error", elapsedMs: 0, error });
      throw error;
    }
  }

  stopRecording(): Promise<string> {
    if (this.finishPromise) return this.finishPromise;
    if (!this.recording) return Promise.resolve("");
    const promise = this.finishCurrentRecording();
    const trackedPromise = promise.finally(() => {
      if (this.finishPromise === trackedPromise) this.finishPromise = undefined;
    });
    this.finishPromise = trackedPromise;
    return trackedPromise;
  }

  cancel(): void {
    this.requestVersion += 1;
    this.clearRecordingTimer();
    const recording = this.recording;
    this.recording = undefined;
    if (recording) {
      try {
        if (recording.recorder.state !== "inactive") recording.recorder.stop();
      } finally {
        this.releaseStream(recording.stream);
      }
    }
    if (this.snapshot.state === "recording" || this.snapshot.state === "transcribing") {
      this.setSnapshot({ state: "ready", elapsedMs: 0 });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.runtime.dispose();
    this.listeners.clear();
    this.transcriptListeners.clear();
  }

  private async finishRecording(): Promise<void> {
    if (this.finishPromise || !this.recording) return;
    await this.stopRecording();
  }

  private async finishCurrentRecording(): Promise<string> {
    const current = this.recording;
    if (!current) return "";
    this.recording = undefined;
    this.clearRecordingTimer();
    const version = ++this.requestVersion;
    const recordingId = Date.now();
    this.setSnapshot({ state: "transcribing", elapsedMs: MAX_RECORDING_MS });
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const onStop = () => {
          const mimeType = current.chunks.find((chunk) => chunk.type)?.type ?? "";
          const recordedAudio = new Blob(current.chunks, { type: mimeType });
          if (recordedAudio.size === 0) {
            reject(new Error("没有录制到音频数据，请重试。"));
            return;
          }
          try {
            const extension = mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
            downloadRecording(recordedAudio, `hellospeech-recording-${recordingId}.${extension}`);
            resolve(recordedAudio);
          } catch (exception) {
            reject(toError(exception, "录音保存失败。"));
          }
        };
        current.recorder.onstop = onStop;
        current.recorder.onerror = () => reject(new Error("录音过程中发生错误。"));
        try {
          if (current.recorder.state !== "inactive") current.recorder.stop();
          else onStop();
        } catch (exception) {
          reject(toError(exception, "录音停止失败。"));
        }
      }).finally(() => this.releaseStream(current.stream));
      const audio = trimSilence(await this.decodeAudio(blob));
      if (version !== this.requestVersion || this.disposed) return "";
      downloadRecording(encodePcm16Wav(audio), `hellospeech-16khz-${recordingId}.wav`);
      const transcript = (await this.runtime.transcribe(audio)).trim();
      if (version !== this.requestVersion || this.disposed) return "";
      this.setSnapshot({ state: "ready", elapsedMs: 0 });
      if (transcript) {
        for (const listener of this.transcriptListeners) listener(transcript);
      }
      return transcript;
    } catch (exception) {
      if (version !== this.requestVersion || this.disposed) return "";
      const error = toError(exception, "语音转文字失败。");
      this.setSnapshot({ state: "error", elapsedMs: 0, error });
      throw error;
    }
  }

  private releaseStream(stream: MediaStreamLike): void {
    for (const track of stream.getTracks()) track.stop();
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer !== undefined) {
      this.clock.clearTimeout(this.recordingTimer);
      this.recordingTimer = undefined;
    }
    if (this.progressTimer !== undefined) {
      this.clock.clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
    this.recordingStartedAt = undefined;
  }

  private setSnapshot(next: Omit<SttSnapshot, "device" | "maxRecordingMs">): void {
    this.snapshot = {
      ...next,
      device: this.device,
      maxRecordingMs: MAX_RECORDING_MS,
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
