import type { KokoroTTS } from "kokoro-js";
import type { Tensor } from "@huggingface/transformers";
import type * as Transformers from "@huggingface/transformers";
import { withTransformersLocalModelPath } from "./transformers-model-loader.js";

export type TtsState = "idle" | "loading" | "ready" | "speaking" | "error";

export type TtsSnapshot = {
  state: TtsState;
  error?: Error;
};

export type AudioSamples = {
  samples: Float32Array;
  sampleRate: number;
};

export interface KokoroTtsRuntime {
  load(): Promise<void>;
  synthesize(text: string): Promise<AudioSamples>;
  dispose(): void;
}

export interface AudioPlayer {
  prime(): void;
  play(audio: AudioSamples): Promise<void>;
  stop(): void;
  dispose(): void;
}

export type KokoroTtsConfig = {
  assetBaseUrl?: string;
  modelId?: string;
  voiceAssetUrl?: string;
  dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  device?: "wasm" | "webgpu";
  runtimeFactory?: () => KokoroTtsRuntime;
  player?: AudioPlayer;
};

type Listener = (snapshot: TtsSnapshot) => void;
type KokoroModelOutput = { waveform?: Tensor };
type KokoroDtype = NonNullable<KokoroTtsConfig["dtype"]>;

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const DEFAULT_ASSET_BASE_URL = env.VITE_KOKORO_ASSET_BASE_URL ?? "/models/kokoro/";
const DEFAULT_MODEL_ID = env.VITE_KOKORO_MODEL_ID ?? "Kokoro-82M";
const DEFAULT_VOICE = "af_heart";
const MAX_SPEECH_CHUNK_LENGTH = 180;
const MAX_KOKORO_SEQUENCE_LENGTH = 511;
const PAUSE_BETWEEN_CHUNKS_MS = 180;
const PAUSE_PUNCTUATION = new Set([",", ":", ";", "—", "–", "-"]);
const PAUSE_DELIMITERS = new Set([...PAUSE_PUNCTUATION, '"']);

class KokoroInputTooLongError extends Error {}

type SpeechPlan = {
  chunks: string[];
  leadingPause: boolean;
  trailingPause: boolean;
};

function isNumericSeparator(text: string, index: number): boolean {
  return /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? "");
}

function parseDtype(value: string | undefined): KokoroDtype {
  switch (value) {
    case "fp32":
    case "fp16":
    case "q8":
    case "q4":
    case "q4f16":
      return value;
    default:
      return "q8";
  }
}

const DEFAULT_DTYPE = parseDtype(env.VITE_KOKORO_DTYPE);

export function selectSpeechText<T extends { text: string }>(message: T): string {
  return message.text;
}

function splitLongSpeechUnit(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!PAUSE_DELIMITERS.has(text[index]!)) continue;
    let end = index;
    while (end + 1 < text.length && PAUSE_DELIMITERS.has(text[end + 1]!)) end++;
    let shouldPause = false;
    for (let delimiterIndex = index; delimiterIndex <= end; delimiterIndex++) {
      if (!isNumericSeparator(text, delimiterIndex)) {
        shouldPause = true;
        break;
      }
    }
    if (!shouldPause) {
      index = end;
      continue;
    }
    appendLengthLimitedChunks(text.slice(start, end + 1).replaceAll('"', ""), maxLength, chunks);
    start = end + 1;
    index = end;
  }
  appendLengthLimitedChunks(text.slice(start).replaceAll('"', ""), maxLength, chunks);
  return chunks;
}

function appendLengthLimitedChunks(text: string, maxLength: number, chunks: string[]): void {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  let current = "";
  for (const word of words) {
    if (word.length > maxLength) {
      if (current) chunks.push(current);
      current = "";
      const characters = Array.from(word);
      for (let offset = 0; offset < characters.length; offset += maxLength) {
        chunks.push(characters.slice(offset, offset + maxLength).join(""));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLength) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
}

function prepareSpeechText(text: string, maxLength = MAX_SPEECH_CHUNK_LENGTH): SpeechPlan {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("语音分段长度必须是正整数。");
  }
  const normalizedText = text.replaceAll("*", "");
  const trimmedText = normalizedText.trim();
  if (!trimmedText) return { chunks: [], leadingPause: false, trailingPause: false };
  const isPauseDelimiter = (character: string | undefined) =>
    character !== undefined && PAUSE_DELIMITERS.has(character);
  return {
    chunks: normalizedText
      .split(/(?<=[.!?])\s+|(?<!\d)\n+(?!\d)/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .flatMap((sentence) => splitLongSpeechUnit(sentence, maxLength)),
    leadingPause: isPauseDelimiter(trimmedText[0]),
    trailingPause: isPauseDelimiter(trimmedText.at(-1)),
  };
}

export function splitSpeechText(text: string, maxLength = MAX_SPEECH_CHUNK_LENGTH): string[] {
  return prepareSpeechText(text, maxLength).chunks;
}

function combineAudioChunks(
  chunks: AudioSamples[],
  leadingPause = false,
  trailingPause = false,
): AudioSamples {
  const first = chunks[0];
  if (!first) throw new Error("没有可播放的语音片段。");
  if (chunks.some((chunk) => chunk.sampleRate !== first.sampleRate)) {
    throw new Error("Kokoro 返回了采样率不一致的音频片段。");
  }
  if (chunks.length === 1 && !leadingPause && !trailingPause) return first;

  const pauseLength = Math.round(first.sampleRate * PAUSE_BETWEEN_CHUNKS_MS / 1000);
  const totalLength = chunks.reduce((length, chunk) => length + chunk.samples.length, 0) +
    pauseLength * (chunks.length - 1 + Number(leadingPause) + Number(trailingPause));
  const samples = new Float32Array(totalLength);
  let offset = leadingPause ? pauseLength : 0;
  for (const [index, chunk] of chunks.entries()) {
    samples.set(chunk.samples, offset);
    offset += chunk.samples.length;
    if (index < chunks.length - 1 || trailingPause) offset += pauseLength;
  }
  return { samples, sampleRate: first.sampleRate };
}

function joinAssetUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function fetchVoice(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Kokoro voice ${DEFAULT_VOICE} 加载失败（${response.status}）。`);
  const data = new Float32Array(await response.arrayBuffer());
  if (data.length < 256) throw new Error("Kokoro voice 文件无效或不完整。");
  return data;
}

class BrowserKokoroTtsRuntime implements KokoroTtsRuntime {
  private model?: KokoroTTS;
  private voice?: Float32Array;
  private phonemize?: (text: string, language?: string) => Promise<string[]>;
  private Tensor?: typeof Transformers.Tensor;

  constructor(
    private readonly assetBaseUrl: string,
    private readonly modelId: string,
    private readonly voiceAssetUrl: string,
    private readonly dtype: NonNullable<KokoroTtsConfig["dtype"]>,
    private readonly device: NonNullable<KokoroTtsConfig["device"]>,
  ) {}

  async load(): Promise<void> {
    const [kokoro, transformers, phonemizer] = await Promise.all([
      import("kokoro-js"),
      import("@huggingface/transformers"),
      import("phonemizer"),
    ]);
    const [loaded, voice] = await Promise.all([
      withTransformersLocalModelPath(transformers.env, this.assetBaseUrl, async () => {
        const [model, tokenizer] = await Promise.all([
          transformers.StyleTextToSpeech2Model.from_pretrained(this.modelId, {
            dtype: this.dtype,
            device: this.device,
            subfolder: "",
          }),
          transformers.AutoTokenizer.from_pretrained(this.modelId),
        ]);
        return { model, tokenizer, Tensor: transformers.Tensor };
      }),
      fetchVoice(this.voiceAssetUrl),
    ]);
    this.model = new kokoro.KokoroTTS(loaded.model as KokoroTTS["model"], loaded.tokenizer);
    this.voice = voice;
    this.phonemize = phonemizer.phonemize;
    this.Tensor = loaded.Tensor;
  }

  async synthesize(text: string): Promise<AudioSamples> {
    if (!this.model || !this.voice || !this.phonemize || !this.Tensor) {
      throw new Error("Kokoro 尚未准备完成。");
    }
    const phonemes = (await this.phonemize(text, "en-us")).join(" ").trim();
    if (!phonemes) throw new Error("这条回复没有可朗读的英文内容。");
    const { input_ids } = this.model.tokenizer(phonemes);
    if (Array.isArray(input_ids)) throw new Error("Kokoro 无法生成有效的输入 token。");
    const sequenceLength = input_ids.dims.at(-1) ?? 0;
    if (sequenceLength > MAX_KOKORO_SEQUENCE_LENGTH) {
      throw new KokoroInputTooLongError("Kokoro 输入超过单次合成长度，正在重新分段。");
    }
    const styleOffset = 256 * Math.min(Math.max(sequenceLength - 2, 0), 509);
    const style = this.voice.slice(styleOffset, styleOffset + 256);
    if (style.length !== 256) throw new Error("Kokoro af_heart voice 文件与模型不匹配。");
    const Tensor = this.Tensor;
    const output = await this.model.model({
      input_ids,
      style: new Tensor("float32", style, [1, 256]),
      speed: new Tensor("float32", [1], [1]),
    }) as KokoroModelOutput;
    const samples = output.waveform?.data;
    if (!(samples instanceof Float32Array)) throw new Error("Kokoro 返回了无效的音频数据。");
    return { samples: new Float32Array(samples), sampleRate: 24_000 };
  }

  dispose(): void {
    void this.model?.model.dispose();
    this.model = undefined;
    this.voice = undefined;
    this.phonemize = undefined;
    this.Tensor = undefined;
  }
}

class WebAudioPlayer implements AudioPlayer {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private resolvePlayback?: () => void;
  private playVersion = 0;

  prime(): void {
    const context = this.ensureContext();
    void context.resume().catch(() => undefined);
  }

  async play(audio: AudioSamples): Promise<void> {
    const context = this.ensureContext();
    const version = ++this.playVersion;
    await context.resume();
    if (version !== this.playVersion) return;
    this.stopSource();
    const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate);
    buffer.copyToChannel(new Float32Array(audio.samples), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.source = source;
    return new Promise<void>((resolve) => {
      this.resolvePlayback = resolve;
      source.onended = () => {
        if (this.source === source) {
          this.source = undefined;
          this.resolvePlayback = undefined;
        }
        resolve();
      };
      source.start();
    });
  }

  stop(): void {
    this.playVersion += 1;
    this.stopSource();
  }

  private stopSource(): void {
    const source = this.source;
    this.source = undefined;
    this.resolvePlayback?.();
    this.resolvePlayback = undefined;
    if (source) {
      try {
        source.stop();
      } catch {
        // The source may already have ended.
      }
      source.disconnect();
    }
  }

  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = undefined;
    if (context) void context.close();
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext();
    return this.context;
  }
}

export class KokoroTtsService {
  private readonly runtime: KokoroTtsRuntime;
  private readonly player: AudioPlayer;
  private readonly listeners = new Set<Listener>();
  private loadPromise?: Promise<void>;
  private requestVersion = 0;
  private snapshot: TtsSnapshot = { state: "idle" };

  constructor(config: KokoroTtsConfig = {}) {
    const assetBaseUrl = config.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL;
    const modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this.runtime = config.runtimeFactory?.() ?? new BrowserKokoroTtsRuntime(
      assetBaseUrl,
      modelId,
      config.voiceAssetUrl ?? joinAssetUrl(joinAssetUrl(assetBaseUrl, modelId), `voices/${DEFAULT_VOICE}.bin`),
      config.dtype ?? DEFAULT_DTYPE ?? "q8",
      config.device ?? "wasm",
    );
    this.player = config.player ?? new WebAudioPlayer();
  }

  get state(): TtsSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  load(): Promise<void> {
    if (this.snapshot.state === "ready" || this.snapshot.state === "speaking") return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.setSnapshot({ state: "loading" });
    this.loadPromise = this.runtime.load()
      .then(() => this.setSnapshot({ state: "ready" }))
      .catch((exception: unknown) => {
        const error = exception instanceof Error ? exception : new Error("Kokoro 初始化失败。");
        this.setSnapshot({ state: "error", error });
        throw error;
      })
      .finally(() => {
        this.loadPromise = undefined;
      });
    return this.loadPromise;
  }

  prime(): void {
    this.player.prime();
  }

  async speak(text: string): Promise<void> {
    const speechText = selectSpeechText({ text });
    if (!speechText.trim()) return;
    const speechPlan = prepareSpeechText(speechText);
    if (!speechPlan.chunks.length) return;
    const version = ++this.requestVersion;
    this.player.stop();
    try {
      await this.load();
      if (version !== this.requestVersion) return;
      this.setSnapshot({ state: "loading" });
      const audioChunks: AudioSamples[] = [];
      const synthesizeChunk = async (chunk: string): Promise<boolean> => {
        if (version !== this.requestVersion) return false;
        try {
          const audio = await this.runtime.synthesize(chunk);
          if (version !== this.requestVersion) return false;
          audioChunks.push(audio);
          return true;
        } catch (exception: unknown) {
          if (!(exception instanceof KokoroInputTooLongError) || chunk.length < 2) throw exception;
          const smallerChunks = splitSpeechText(chunk, Math.max(1, Math.floor(chunk.length / 2)));
          if (smallerChunks.length < 2) throw exception;
          for (const smallerChunk of smallerChunks) {
            if (!await synthesizeChunk(smallerChunk)) return false;
          }
          return true;
        }
      };
      for (const chunk of speechPlan.chunks) {
        if (!await synthesizeChunk(chunk)) return;
      }
      if (version !== this.requestVersion) return;
      const audio = combineAudioChunks(audioChunks, speechPlan.leadingPause, speechPlan.trailingPause);
      if (version !== this.requestVersion) return;
      this.setSnapshot({ state: "speaking" });
      await this.player.play(audio);
      if (version === this.requestVersion) this.setSnapshot({ state: "ready" });
    } catch (exception: unknown) {
      if (version !== this.requestVersion) return;
      const error = exception instanceof Error ? exception : new Error("Kokoro 播放失败。");
      this.setSnapshot({ state: "error", error });
    }
  }

  stop(): void {
    this.requestVersion += 1;
    this.player.stop();
    if (this.snapshot.state === "speaking" || this.snapshot.state === "loading") {
      this.setSnapshot({ state: "ready" });
    }
  }

  dispose(): void {
    this.requestVersion += 1;
    this.player.dispose();
    this.runtime.dispose();
    this.listeners.clear();
  }

  private setSnapshot(snapshot: TtsSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
