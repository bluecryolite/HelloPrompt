<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { ApiError } from "../services/http.js";
import { KokoroTtsService, selectSpeechText, type TtsSnapshot } from "../services/kokoro-tts.js";
import { sendHelloSpeech, startHelloSpeech, type HelloSpeechResponse } from "../features/hello-speech.js";

type Message = {
  id: number;
  role: "user" | "bot" | "error";
  text: string;
  response?: HelloSpeechResponse;
  showMetadata?: boolean;
};

function browserSupportsWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

const input = ref("");
const messages = ref<Message[]>([]);
const sessionId = ref<string>();
const loading = ref(false);
const startingNewChat = ref(false);
const chatReady = ref(false);
const status = ref<HelloSpeechResponse["status"]>("in_progress");
const tts = new KokoroTtsService({ device: browserSupportsWebGpu() ? "webgpu" : "wasm" });
const ttsState = ref<TtsSnapshot["state"]>(tts.state.state);
const ttsError = ref<string>();
const activeMessageId = ref<number>();
let nextMessageId = 0;

function addMessage(role: Message["role"], text: string, response?: HelloSpeechResponse): Message {
  const message = { id: nextMessageId++, role, text, response, showMetadata: false };
  messages.value.push(message);
  if (role === "bot") void speakMessage(message);
  return message;
}

function showError(message: string) {
  addMessage("error", message);
}

function refreshForWrongRequest(message: string) {
  showError(message);
  window.location.reload();
}

async function newChat() {
  if (loading.value) return;

  tts.prime();
  tts.stop();
  activeMessageId.value = undefined;
  loading.value = true;
  startingNewChat.value = true;
  try {
    const response = await startHelloSpeech();
    sessionId.value = response.sessionId;
    status.value = response.status;
    chatReady.value = true;
    messages.value = [];
    addMessage("bot", response.response, response);
  } catch (exception) {
    showError(exception instanceof Error ? exception.message : "新聊天创建失败，请稍后重试。");
  } finally {
    startingNewChat.value = false;
    loading.value = false;
  }
}

function speakMessage(message: Message) {
  if (message.role !== "bot") return;
  activeMessageId.value = message.id;
  ttsError.value = undefined;
  tts.prime();
  void tts.speak(selectSpeechText(message)).then(() => {
    if (activeMessageId.value === message.id && ttsState.value === "ready") {
      activeMessageId.value = undefined;
    }
  });
}

function toggleSpeech(message: Message) {
  tts.prime();
  if (activeMessageId.value === message.id && (ttsState.value === "speaking" || ttsState.value === "loading")) {
    tts.stop();
    activeMessageId.value = undefined;
    return;
  }
  speakMessage(message);
}

function soundLabel(message: Message): string {
  if (activeMessageId.value !== message.id) return "朗读此回复";
  if (ttsState.value === "error") return "重试朗读此回复";
  if (ttsState.value === "speaking" || ttsState.value === "loading") return "停止播放";
  return "朗读此回复";
}

function retrySpeech() {
  const message = messages.value.find((item) => item.id === activeMessageId.value && item.role === "bot");
  if (message) {
    speakMessage(message);
  } else {
    tts.prime();
    void tts.load().catch(() => undefined);
  }
}

function updateTtsSnapshot(snapshot: TtsSnapshot) {
  ttsState.value = snapshot.state;
  ttsError.value = snapshot.error?.message;
}

const unsubscribeFromTts = tts.subscribe(updateTtsSnapshot);

onMounted(() => {
  void tts.load().catch(() => undefined);
});

onUnmounted(() => {
  unsubscribeFromTts();
  tts.dispose();
});

async function submit() {
  const value = input.value;
  if (!value.trim() || loading.value) {
    if (!value.trim()) showError("请输入要发送的内容。");
    return;
  }
  if (!chatReady.value || !sessionId.value) {
    showError("请先点击“新聊天”按钮。");
    return;
  }

  tts.prime();
  addMessage("user", value);
  input.value = "";
  loading.value = true;
  try {
    const response = await sendHelloSpeech(value, sessionId.value);
    if (sessionId.value !== response.sessionId) {
      refreshForWrongRequest("请求无效，会话已失效，页面即将刷新。");
      return;
    }
    status.value = response.status;
    addMessage("bot", response.response, response);
  } catch (exception) {
    if (exception instanceof ApiError && exception.code === "INVALID_SESSION") {
      refreshForWrongRequest(exception.message);
    } else {
      showError(exception instanceof Error ? exception.message : "请求失败，请稍后重试。");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="card hello-speech">
    <div class="eyebrow">HELLO SPEECH</div>
    <h1>Hello Speech</h1>
    <p class="intro">输入文字与 Copilot 对话。回复会在浏览器中使用 Kokoro 朗读。</p>
    <button class="secondary new-chat" type="button" :disabled="loading" @click="newChat">
      {{ startingNewChat ? "新聊天准备中…" : "新聊天" }}
    </button>
    <section v-if="messages.length" class="chat-messages" aria-live="polite">
      <article v-for="message in messages" :key="message.id" class="message-row" :class="`message-${message.role}`">
        <div class="message-bubble" :role="message.role === 'error' ? 'alert' : undefined">
          <p>{{ message.text }}</p>
          <template v-if="message.response">
            <div class="bot-actions">
              <button
                v-if="message.role === 'bot'"
                class="sound-button"
                :class="{ speaking: activeMessageId === message.id && ttsState === 'speaking' }"
                type="button"
                :aria-label="soundLabel(message)"
                :aria-pressed="activeMessageId === message.id && ttsState === 'speaking'"
                @click="toggleSpeech(message)"
              >
                <span aria-hidden="true">{{ activeMessageId === message.id && (ttsState === "loading" || ttsState === "speaking") ? "🔊" : "🔈" }}</span>
                <span>{{ soundLabel(message) }}</span>
              </button>
              <button class="link metadata-toggle" type="button" @click="message.showMetadata = !message.showMetadata">
                {{ message.showMetadata ? "less" : "more" }}
              </button>
            </div>
            <dl v-if="message.showMetadata" class="metadata">
              <dt>模型</dt><dd>{{ message.response.model }}</dd>
              <dt>耗时</dt><dd>{{ (message.response.elapsedMs / 1000).toFixed(1) }} 秒</dd>
              <dt>输入 token</dt><dd>{{ message.response.inputTokens }}</dd>
              <dt>输出 token</dt><dd>{{ message.response.outputTokens }}</dd>
              <dt>缓存读 token</dt><dd>{{ message.response.cacheReadTokens }}</dd>
              <dt>缓存写 token</dt><dd>{{ message.response.cacheWriteTokens }}</dd>
            </dl>
          </template>
        </div>
      </article>
    </section>
    <div v-if="ttsState === 'loading'" class="tts-loading" role="status" aria-live="polite">
      <span class="spinner"></span>{{ activeMessageId === undefined ? "正在加载 Kokoro…" : "正在准备语音…" }}
    </div>
    <div v-if="ttsState === 'error'" class="tts-error" role="alert">
      {{ ttsError ?? "语音播放失败。" }}
      <button class="link" type="button" @click="retrySpeech">重试</button>
    </div>
    <form class="chat-form" @submit.prevent="submit">
      <label class="sr-only" for="hello-speech-input">输入消息</label>
      <input
        id="hello-speech-input"
        v-model="input"
        class="chat-input"
        type="text"
        placeholder="输入消息"
        autocomplete="off"
        :disabled="loading"
      >
      <button class="primary chat-submit" type="submit" :disabled="loading || !chatReady || status === 'completed'">
        {{ loading ? "发送中…" : "发送" }}
      </button>
    </form>
    <div v-if="loading" class="loading" aria-live="polite"><span class="spinner"></span>正在等待回复…</div>
  </main>
</template>

<style scoped>
.hello-speech{width:min(92vw,760px)}
.secondary{width:auto;border:1px solid #5279e6;border-radius:11px;padding:12px 18px;background:#fff;color:#5279e6;font:inherit;font-weight:700;cursor:pointer}
.secondary:disabled{opacity:.6;cursor:wait}
.new-chat{margin-bottom:14px}
.chat-form{display:grid;grid-template-columns:1fr auto;gap:10px}
.chat-input{width:100%;border:1px solid #dbe1ec;border-radius:10px;padding:13px;color:#202640;font:inherit}
.chat-submit{width:auto;padding-inline:24px}
.chat-messages{display:grid;gap:14px;margin-top:24px}
.message-row{display:flex}
.message-user{justify-content:flex-end}
.message-bubble{max-width:82%;padding:12px 15px;border-radius:16px;background:#f0f4fc;overflow-wrap:anywhere}
.message-user .message-bubble{background:#5279e6;color:#fff;border-bottom-right-radius:4px}
.message-bot .message-bubble{border-bottom-left-radius:4px}
.message-error{justify-content:flex-start}
.message-error .message-bubble{background:#fff0f0;color:#c34343;border:1px solid #f0caca;border-bottom-left-radius:4px}
.message-bubble p{white-space:pre-wrap;margin:0}
.bot-actions{display:flex;align-items:center;gap:12px;margin-top:10px}
.sound-button{display:inline-flex;align-items:center;gap:6px;border:1px solid #dbe1ec;border-radius:9px;padding:6px 9px;background:#fff;color:#5279e6;cursor:pointer;font:inherit;font-size:12px;font-weight:700}
.sound-button:hover,.sound-button.speaking{border-color:#5279e6;background:#edf2ff}
.sound-button.speaking{box-shadow:0 0 0 2px #9ab5ff}
.metadata-toggle{padding:0;font-size:12px}
.message-user .metadata-toggle{color:#fff}
.metadata{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:10px 0 0;padding-top:10px;border-top:1px solid #dbe1ec;font-size:12px}
.message-user .metadata{border-color:#ffffff66}
.metadata dt{font-weight:700}
.metadata dd{margin:0;text-align:right;overflow-wrap:anywhere}
.tts-loading{color:#65708b;text-align:center;margin:20px 0 0}
.tts-error{display:flex;align-items:center;gap:8px;margin-top:16px;padding:10px 12px;border:1px solid #f0caca;border-radius:10px;background:#fff0f0;color:#c34343;font-size:13px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:480px){.chat-form{grid-template-columns:1fr}.chat-submit{width:100%}.message-bubble{max-width:92%}}
</style>
