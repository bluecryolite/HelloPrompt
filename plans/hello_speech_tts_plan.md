# Hello Speech MeloTTS Plan

## Problem

Extend the existing `HelloSpeech` Vue chat page so bot replies can be spoken with MeloTTS entirely in the browser. Each bot reply needs a sound control, automatic speech, a speaking state indicator, and an initial TTS loading indicator. Response metadata must remain visual-only and must never be included in synthesized speech.

The current repository already contains `src/client/components/HelloSpeech.vue`, the Hello Speech API client, and the server-side Copilot session service. It does not contain `HelloPrompt.vue`, a MeloTTS dependency, a browser TTS runtime, model assets, or an audio service. The existing `HelloSpeech.vue` message-bubble styles are therefore the current in-repository visual reference for preserving the chat layout.

## Proposed approach

1. Select and add a browser-compatible MeloTTS JavaScript/WebAssembly runtime and model assets.
   - Verify that the runtime can execute in a browser bundle, supports the required language/voice, and can return audio data without a server request or file download.
   - Confirm model/runtime licensing and asset distribution requirements before adding files or package dependencies.
   - Prefer lazy loading and, if supported, a Web Worker so first-load model initialization and synthesis do not block Vue rendering.
   - Keep the runtime and model entirely client-side; do not add a MeloTTS server proxy or expose new credentials.

2. Add a client-side TTS abstraction.
   - Create a focused service such as `src/client/services/melo-tts.ts` that owns runtime initialization, model loading, synthesis, playback, cancellation, and cleanup.
   - Expose explicit states such as `idle`, `loading`, `ready`, `speaking`, and `error`, plus a `load()`/preload operation and a `speak(text)` operation.
   - Synthesize only in memory and play through browser audio APIs (`AudioContext`/`AudioBuffer` or an in-memory `Blob` URL as required by the selected runtime); never trigger a download.
   - Ensure repeated playback stops or cancels the previous utterance, stale completions cannot clear a newer speaking state, and object URLs/audio nodes are released.
   - Surface initialization and synthesis errors to the component instead of silently falling back to another speech engine.

3. Integrate TTS state into `HelloSpeech.vue`.
   - Preserve the existing left/right chat-bubble structure and current metadata disclosure behavior; do not render metadata as part of the spoken string.
   - Add an accessible sound button to every bot message, with an icon/label that distinguishes ready, loading, speaking, stopped, and failed states.
   - Highlight only the currently speaking bot message and expose the state with `aria-pressed`/`aria-label` and a visible focus style.
   - Start loading the MeloTTS runtime/model when the page mounts or when the first chat is initiated, and show a user-visible loading indicator while the first initialization is pending.
   - Automatically speak each newly appended bot response once the runtime is ready. If initialization is still in progress, queue the latest eligible response and play it after initialization; avoid replaying the same message on unrelated Vue updates.
   - Allow a user click on a bot message’s sound control to start/restart that response, and stop the active playback when appropriate.
   - Stop playback and dispose listeners/audio resources on component unmount, new-chat reset, and replacement by another response.
   - Keep the spoken input limited to `message.text`; the model, duration, input/output/cache token counts, and any metadata labels remain excluded even when metadata is expanded.

4. Keep browser interaction and autoplay behavior reliable.
   - Use the existing “新聊天” and submit button interactions as user gestures for normal automatic playback.
   - Handle browser autoplay restrictions explicitly: if automatic playback is rejected, retain the response and let the sound button retry it with a user gesture while showing a concise status/error.
   - Prevent duplicate automatic playback when a response is received, when the TTS runtime finishes loading, or when the component rerenders.

5. Update dependencies and static assets.
   - Modify `package.json` and `package-lock.json` only after selecting the compatible browser MeloTTS runtime.
   - Add model assets under the project’s static/public asset convention if they are distributable and appropriately sized; otherwise document the configured asset URL and loading contract without embedding credentials.
   - Adjust Vite configuration only if the selected runtime requires worker files, WASM, model URL handling, or special asset inclusion.
   - Add any required user-facing configuration (language, speaker, model URL, or asset base path) using the project’s existing environment/configuration conventions, keeping secrets out of client bundles.

6. Add focused coverage and validate the integration.
   - Add unit coverage for TTS text selection/exclusion, message-to-speech deduplication, cancellation/replacement, and loading/speaking/error state transitions using an injected fake runtime/audio adapter.
   - Extend component or service coverage only with the test mechanisms already present; do not introduce a new browser test framework solely for this feature.
   - Run the existing `npm test` and `npm run build`.
   - Manually verify first-load progress, automatic speech after a new bot response, sound-button replay, active-icon highlighting, cancellation when another message starts, no downloaded file, and metadata exclusion.
   - Test both a browser that permits playback after the initiating gesture and a browser that blocks autoplay, confirming the retry path remains usable.

## Files and components expected to change

- `src/client/components/HelloSpeech.vue`: message sound controls, automatic speech orchestration, loading/error indicators, and lifecycle cleanup.
- `src/client/services/melo-tts.ts` (new): browser MeloTTS runtime/model and in-memory audio playback abstraction.
- `src/client/components/HelloSpeech.test.ts` or an existing client-test location (new/extended as supported): state and speech integration tests.
- `package.json` and `package-lock.json`: selected browser runtime dependency and related build dependency, if required.
- `vite.config.ts`: only if the selected runtime needs explicit WASM/worker/model asset handling.
- `public/` or the project’s existing static asset location: only for distributable MeloTTS model assets.
- `.env.example`: only for non-secret client configuration such as an asset base URL, if the selected runtime needs it.

The existing server files (`src/server/app.ts`, `src/server/features/hello-speech/service.ts`) should remain unchanged because MeloTTS is explicitly required to run in the browser and the existing bot response API already supplies the text and metadata separately.

## Important decisions and constraints

- Browser execution is a hard requirement; do not substitute the Web Speech API, server-side Python MeloTTS, or a server-generated audio endpoint.
- “Without downloading any file” means generated audio must remain in memory and be sent directly to browser playback; no download link, attachment, or persistent audio file is created.
- The exact runtime/package is not yet present in the repository and must be selected as an implementation prerequisite. If no browser-compatible MeloTTS runtime exists for the required voice/language, implementation must stop at that dependency decision rather than silently switching engines.
- The repository has no `HelloPrompt.vue`; preserve the current `HelloSpeech.vue` bubble presentation and shared styling conventions as the available reference.
- Automatic playback is subject to browser media policies. The UI must provide a clear manual retry control when a browser rejects automatic playback.

## Acceptance criteria

1. The existing Hello Speech page retains its current chat-bubble layout and metadata disclosure.
2. Every bot response has an accessible sound icon/control.
3. Each new bot response is automatically spoken by the browser-side MeloTTS runtime when playback is permitted.
4. Clicking a response’s sound control starts or restarts that response without contacting the server or downloading an audio file.
5. The active response’s sound control is visibly highlighted and correctly reflects speaking state.
6. The first MeloTTS runtime/model load shows a loading indicator; initialization errors are visible and retryable.
7. Only the bot response text is synthesized; model, duration, input/output/cache token metadata is never spoken.
8. Playback cancellation, component unmount, and repeated responses do not leave stale audio or speaking indicators.
9. `npm test` and `npm run build` pass with the selected browser runtime and assets.
