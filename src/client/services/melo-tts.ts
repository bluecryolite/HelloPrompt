import type * as Ort from "onnxruntime-web";

export type TtsState = "idle" | "loading" | "ready" | "speaking" | "error";

export type TtsSnapshot = {
  state: TtsState;
  error?: Error;
};

export type AudioSamples = {
  samples: Float32Array;
  sampleRate: number;
};

export interface MeloTtsRuntime {
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

export type MeloTtsConfig = {
  assetBaseUrl?: string;
  wasmBaseUrl?: string;
  runtimeFactory?: () => MeloTtsRuntime;
  player?: AudioPlayer;
};

type Listener = (snapshot: TtsSnapshot) => void;

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const DEFAULT_ASSET_BASE_URL = env.VITE_MELO_TTS_ASSET_BASE_URL ?? "/tts/melo/";
const DEFAULT_WASM_BASE_URL = env.VITE_MELO_TTS_WASM_BASE_URL;

export function selectSpeechText<T extends { text: string }>(message: T): string {
  return message.text;
}

function joinAssetUrl(baseUrl: string, filename: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${filename}`;
}

async function fetchText(url: string, filename: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`MeloTTS ${filename} 加载失败（${response.status}）。`);
  return response.text();
}

function parseTokenMap(contents: string): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.lastIndexOf(" ");
    if (separator <= 0) continue;
    const token = line.slice(0, separator).trim();
    const id = Number(line.slice(separator + 1).trim());
    if (token && Number.isInteger(id)) tokens.set(token, id);
  }
  return tokens;
}

function parseLexicon(contents: string): Map<string, string[]> {
  const lexicon = new Map<string, string[]>();
  for (const line of contents.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length > 1) lexicon.set(fields[0], fields.slice(1));
  }
  return lexicon;
}

function getPhonesAndTones(lexicon: Map<string, string[]>, text: string): { phones: string[]; tones: number[] } {
  const phones: string[] = [];
  const tones: number[] = [];
  const segments = text.match(/[\p{Script=Han}]|[A-Za-z]+(?:['’-][A-Za-z]+)?|\d+|[^\s]/gu) ?? [];

  for (const segment of segments) {
    const pronunciation = lexicon.get(segment) ?? [...segment].flatMap((character) => lexicon.get(character) ?? []);
    if (!pronunciation.length) continue;
    const toneCount = pronunciation.length % 2 === 0 ? pronunciation.length / 2 : 0;
    const segmentPhones = toneCount ? pronunciation.slice(0, toneCount) : pronunciation;
    const segmentTones = toneCount ? pronunciation.slice(toneCount).map((tone) => Number(tone) || 0) : [];
    phones.push(...segmentPhones);
    tones.push(...(segmentTones.length ? segmentTones : segmentPhones.map(() => 0)));
  }

  return { phones, tones };
}

class BrowserMeloTtsRuntime implements MeloTtsRuntime {
  private ort?: typeof Ort;
  private session?: Ort.InferenceSession;
  private tokens?: Map<string, number>;
  private lexicon?: Map<string, string[]>;

  constructor(
    private readonly assetBaseUrl: string,
    private readonly wasmBaseUrl?: string,
  ) {}

  async load(): Promise<void> {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    if (this.wasmBaseUrl) ort.env.wasm.wasmPaths = this.wasmBaseUrl;

    const [tokenContents, lexiconContents] = await Promise.all([
      fetchText(joinAssetUrl(this.assetBaseUrl, "tokens.txt"), "tokens.txt"),
      fetchText(joinAssetUrl(this.assetBaseUrl, "lexicon.txt"), "lexicon.txt"),
    ]);
    const session = await ort.InferenceSession.create(joinAssetUrl(this.assetBaseUrl, "model.onnx"), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    this.ort = ort;
    this.session = session;
    this.tokens = parseTokenMap(tokenContents);
    this.lexicon = parseLexicon(lexiconContents);
  }

  async synthesize(text: string): Promise<AudioSamples> {
    if (!this.ort || !this.session || !this.tokens || !this.lexicon) {
      throw new Error("MeloTTS 尚未准备完成。");
    }
    const { phones, tones } = getPhonesAndTones(this.lexicon, text);
    if (!phones.length) throw new Error("这条回复没有可朗读的内容。");

    const blank = this.tokens.get("_");
    const unknown = this.tokens.get("UNK");
    const ids: number[] = [];
    const expandedTones: number[] = [];
    for (let index = 0; index < phones.length; index += 1) {
      if (blank !== undefined) {
        ids.push(blank);
        expandedTones.push(0);
      }
      const tokenId = this.tokens.get(phones[index]) ?? unknown;
      if (tokenId === undefined) continue;
      ids.push(tokenId);
      expandedTones.push(tones[index] ?? 0);
    }
    if (!ids.length) throw new Error("MeloTTS 无法识别这条回复。");

    const input = <typeof this.ort>this.ort;
    const length = ids.length;
    const result = await this.session.run({
      x: new input.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, length]),
      x_lengths: new input.Tensor("int64", BigInt64Array.from([length], BigInt), [1]),
      tones: new input.Tensor("int64", BigInt64Array.from(expandedTones, BigInt), [1, length]),
      sid: new input.Tensor("int64", BigInt64Array.from([0n]), [1]),
      noise_scale: new input.Tensor("float32", new Float32Array([0.667]), [1]),
      length_scale: new input.Tensor("float32", new Float32Array([1]), [1]),
      noise_scale_w: new input.Tensor("float32", new Float32Array([0.8]), [1]),
    });
    const output = result.y ?? result.output;
    if (!output || !(output.data instanceof Float32Array)) {
      throw new Error("MeloTTS 返回了无效的音频数据。");
    }
    return { samples: new Float32Array(output.data), sampleRate: 44100 };
  }

  dispose(): void {
    this.session?.release();
    this.session = undefined;
    this.ort = undefined;
    this.tokens = undefined;
    this.lexicon = undefined;
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

export class MeloTtsService {
  private readonly runtime: MeloTtsRuntime;
  private readonly player: AudioPlayer;
  private readonly listeners = new Set<Listener>();
  private loadPromise?: Promise<void>;
  private requestVersion = 0;
  private snapshot: TtsSnapshot = { state: "idle" };

  constructor(config: MeloTtsConfig = {}) {
    this.runtime = config.runtimeFactory?.() ??
      new BrowserMeloTtsRuntime(config.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL, config.wasmBaseUrl ?? DEFAULT_WASM_BASE_URL);
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
        const error = exception instanceof Error ? exception : new Error("MeloTTS 初始化失败。");
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
    const version = ++this.requestVersion;
    this.player.stop();
    try {
      await this.load();
      if (version !== this.requestVersion) return;
      this.setSnapshot({ state: "loading" });
      const audio = await this.runtime.synthesize(speechText);
      if (version !== this.requestVersion) return;
      this.setSnapshot({ state: "speaking" });
      await this.player.play(audio);
      if (version === this.requestVersion) this.setSnapshot({ state: "ready" });
    } catch (exception: unknown) {
      if (version !== this.requestVersion) return;
      const error = exception instanceof Error ? exception : new Error("MeloTTS 播放失败。");
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
