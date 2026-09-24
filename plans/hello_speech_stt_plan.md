# Hello Speech Browser Speech-to-Text Plan

## Problem and goal

Replace the existing text-entry control on the Hello Speech page with a press-and-hold microphone interaction. While the user holds the microphone, the browser records English audio; when the user releases it, a local Whisper model transcribes the recording in the browser. The transcript must be shown as the user's chat bubble and automatically submitted to the existing Hello Speech Copilot endpoint so the normal bot reply flow remains intact.

The requirement names `HelloPrompt/src/client/components/HelloSpeech.vue` and `HelloPrompt/src/client/components/HelloPrompt.vue`, but this repository contains only `src/client/components/HelloSpeech.vue`; there is no `HelloPrompt.vue`. The existing `HelloSpeech.vue` message list is therefore the integration target.

## Confirmed behavior decisions

- A completed transcript is displayed immediately as a user message and then submitted automatically to `/features/hello-speech`.
- WebGPU is preferred for Whisper inference when available; the implementation falls back to WASM/CPU when WebGPU is unavailable.
- Recording remains English-only and the Whisper pipeline should use an English model/configuration.
- The existing session, bot-response, metadata, TTS, loading, error, and session-mismatch behavior remains unchanged unless it must be coordinated with recording/transcription state.

## Proposed implementation

### 1. Add a browser Whisper service

Create `src/client/services/whisper-stt.ts` with a narrow, testable abstraction:

- Define explicit states such as `idle`, `loading`, `ready`, `recording`, `transcribing`, and `error`.
- Configure Transformers.js for local-only model loading using `/models/whisper/`, with remote-model loading disabled.
- Use the English `Xenova/whisper-small.en` model, with the quantized ONNX files and dtype selected from the exact model assets downloaded for the supported Transformers.js version.
- Select WebGPU when `navigator.gpu` is available and WASM/CPU otherwise. Expose the selected device in the service snapshot.
- Start loading the pipeline from the page's `onMounted` lifecycle so model initialization begins while the page is loading, while still sharing one in-flight load promise with the first recording. Surface model/layout/runtime errors and show the preload state in the UI.
- Inject browser adapters for `MediaRecorder`, `getUserMedia`, audio decoding, and the Transformers pipeline for Node-test coverage.
- Implement recording start/stop/cancel and release every `MediaStreamTrack` on all success and failure paths.
- Enforce a hard 20-second recording limit. Start a timer only after recording successfully begins; when it expires, stop the recorder, release the microphone stream, and continue automatically with transcription. Manual release before 20 seconds follows the same path.
- Convert the recording to mono 16 kHz `Float32Array` input for Whisper, selecting a supported `MediaRecorder` MIME type.
- Ensure only the latest transcription request can update state; ignore stale results after replacement or disposal.
- Pass English language/task settings where supported and return trimmed plain text.

### 2. Replace text entry with press-and-hold recording

Update `src/client/components/HelloSpeech.vue`:

- Remove the visible text input, form submit handler, and text submit button.
- Add an accessible microphone button with a microphone icon, `aria-label`, pressed state, and visible recording state.
- Start on pointer down and stop on pointer up, pointer cancel, or lost pointer capture. Support keyboard hold semantics without double-starting from synthesized pointer events.
- Require an initialized chat session before recording and preserve the existing error presentation.
- Begin Whisper model loading as soon as the page mounts and show a loading/preparing status while it is in progress; do not request microphone permission merely because the model is being preloaded.
- Disable recording while transcribing, sending a transcript, when the conversation is completed, or after unmount; keep manual retry available after recoverable errors.
- Show elapsed/remaining recording time while holding the microphone and automatically stop at 20 seconds with a clear status that transcription is starting.
- On release, await the transcript, add it as a user bubble, and reuse/refactor the current submission logic to send it automatically with the current session ID.
- Preserve chronological messages, bot replies, metadata disclosure, session checks, TTS behavior, and API error handling.
- Do not create a bubble or API request for empty/no-speech output.
- Stop/dispose the Whisper service during new-chat reset and component unmount without interfering with Kokoro cleanup.
- Add concise status UI for permission, recording, model loading, transcription, selected backend, and retryable errors.

### 3. Add local model assets and documentation

Use a model-root layout that mirrors the model ID:

```text
public/
└── models/
    └── whisper/
        └── Xenova/
            └── whisper-small.en/
                ├── config.json
                ├── generation_config.json
                ├── preprocessor_config.json
                ├── tokenizer.json
                ├── tokenizer_config.json
                └── onnx/
                    └── <selected quantized or WebGPU-compatible ONNX file>
```

Confirm the exact file list against the selected model revision and Transformers.js loader. Create `docs/whisper-local-model.md` with acquisition commands, licensing/storage guidance, same-origin URL mappings, the rule against absolute filesystem paths, and verification that no Hugging Face fallback requests occur. Add only non-secret environment settings if configuration is needed. Use Git LFS or release storage if model binaries should not be committed to ordinary Git.

### 4. Add focused tests and validation

Create `src/client/services/whisper-stt.test.ts` with injected fakes covering WebGPU/WASM selection, local-only configuration, page-load preload and shared loading, permission and codec errors, recording-track cleanup, the hard 20-second timeout, audio normalization, empty/successful transcripts, cancellation, stale-result suppression, and disposal.

Do not add a browser test framework solely for this feature. Validate with the existing `npm test` and `npm run build`, plus manual localhost checks for hold-to-record, release-to-transcribe, transcript bubble display, automatic chat submission, session reuse, local model requests, WebGPU selection, WASM fallback, and retryable failures.

## Files expected to change

- `src/client/components/HelloSpeech.vue`
- `src/client/services/whisper-stt.ts`
- `src/client/services/whisper-stt.test.ts`
- `docs/whisper-local-model.md`
- `.env.example` only if non-secret Whisper configuration is needed
- `package.json` and `package-lock.json` only if an additional runtime dependency is required
- `public/models/whisper/Xenova/whisper-small.en/`
- `src/client/style.css` only if shared microphone/status styles are preferable

The existing server route and `src/client/features/hello-speech.ts` should remain unchanged because they already accept the transcript as text and return the existing chat response contract.

## Acceptance criteria

1. No visible text input or submit button remains; an accessible microphone control is present.
2. Holding records audio; releasing stops recording and begins local Whisper transcription.
3. Whisper model loading starts during page loading, is visible as a status, and does not request microphone permission by itself.
4. Recording never exceeds 20 seconds; reaching the limit automatically stops recording and begins transcription.
5. Whisper assets load from same-origin `/models/whisper/` paths and remote loading is disabled.
6. WebGPU is used when available, with explicit WASM/CPU fallback.
7. The English transcript appears as a user bubble and is automatically submitted to the existing chat endpoint.
8. Existing sessions, bot replies, TTS controls, metadata, completed-session handling, and errors remain intact.
9. Permission, codec, empty speech, model, cancellation, timeout, and stale-result paths are recoverable and release resources.
10. Documentation explains model acquisition, file placement, and filesystem-to-localhost URL mapping.
11. Existing tests and build pass without server-side audio or client credentials.
