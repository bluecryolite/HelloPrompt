# Hello Speech Chatbot Feature Plan

## Goal

Add a Vue chatbot shell at `/features/hello-speech` that sends text to a server-side GitHub Copilot session and displays the response. This feature only renders bot text; it does not synthesize, play, or otherwise process speech.

## Existing Architecture to Reuse

- `src/client/App.vue` is the lightweight History API feature hub and should register the new page there.
- `src/client/services/http.ts` provides same-origin JSON requests and consistent API errors.
- `src/server/app.ts` registers feature endpoints and maps typed service errors to HTTP responses.
- `src/server/features/hello-world/core.ts` owns the reusable Copilot SDK client construction and session creation defaults.
- Existing feature components and `src/client/style.css` establish the UI and responsive styling conventions.

## Target Architecture

```text
src/
  client/
    App.vue                              # Register /features/hello-speech
    components/
      HelloSpeech.vue                    # Chat input, messages, metadata toggle
    features/
      hello-speech.ts                    # Request/response types and API client
  server/
    app.ts                               # Register POST /features/hello-speech
    features/
      hello-speech/
        service.ts                       # Session lifecycle and bot request
      hello-world/
        core.ts                          # Reused Copilot SDK client and session factory
```

## Implementation Steps

1. Define the server API contract.
   - Add `POST /features/hello-speech`.
   - Accept exactly `{ "input": string, "sessionId"?: string }`; reject missing, empty, non-string, or extra fields with the existing invalid-request error contract.
   - Return `{ response, sessionId, model, elapsedMs, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.
   - Keep the Copilot token and raw SDK objects server-only.

2. Reuse the existing Copilot SDK client.
   - Use `createCopilotClient` and `createSession` from `src/server/features/hello-world/core.ts`; do not introduce or depend on `src/server/services/copilot.ts` for this feature.
   - If no session ID is supplied, create a session with the existing helper and use the SDK-generated session ID in the response.
   - If a session ID is supplied, first call the GitHub Copilot SDK's `getSessionMetadata(sessionId)` (or the equivalent SDK session lookup) and verify that it returns an existing session.
   - Only after the existence check succeeds, call `resumeSession(sessionId)` and send the input into that conversation so history is preserved.
   - Attach usage-event aggregation for each request and return the selected model plus elapsed time and all four token counters.
   - Ensure successful, failed, and timed-out requests disconnect the session and release concurrency slots.
   - Convert an SDK lookup result of `undefined` or an unresumable session into a typed `INVALID_SESSION`/wrong-request error; propagate transport/authentication failures from the lookup through the existing upstream error handling.

3. Implement the feature service and route.
   - Create `src/server/features/hello-speech/service.ts` to validate the request, choose create versus resume behavior, send the prompt, and normalize the response to the API contract.
   - Use a narrowly scoped system instruction that asks for a normal textual answer; do not add speech generation or tool access.
   - Add the route in `src/server/app.ts`, preserving the existing JSON parsing and error handling.
   - Extend the server error mapping with a client-visible invalid-session response that tells the user the request is invalid and the page must be refreshed.

4. Add the browser API client.
   - Create `src/client/features/hello-speech.ts` with strict runtime validation for the response shape and numeric usage fields.
   - Call `requestJson` with `POST /features/hello-speech` and send `input` plus the optional local session ID.
   - Expose typed response metadata without leaking implementation-specific SDK fields.

5. Build the chatbot component.
   - Create `src/client/components/HelloSpeech.vue`.
   - Render a text input and submit button; disable both while a request is pending and show a clear loading state.
   - Store the first returned session ID locally and include it on every later request.
   - Maintain a message list where user bubbles are right-aligned and bot bubbles are left-aligned, in chronological order.
   - After each response, compare the returned session ID with the local session ID. If they differ, show the wrong-request state and call `window.location.reload()` rather than continuing with a mismatched conversation.
   - Keep model, elapsed time, input tokens, output tokens, cache-read tokens, and cache-write tokens collapsed by default. Add a per-response `more` link/button to reveal and hide that metadata without another API call.
   - Render bot text as text nodes, not HTML, and surface network/API failures with the existing error presentation.

6. Register the page in the feature hub.
   - Add a typed feature entry and navigation path (use `/features/hello-speech`) in `src/client/App.vue`.
   - Render `HelloSpeech.vue` from the feature-page branch and preserve back navigation, browser history handling, and the existing not-found page.

7. Update styling.
   - Add scoped or shared styles for the chat layout, left/right bubbles, input row, loading/error states, metadata disclosure, and mobile wrapping.
   - Preserve existing focus-visible styles and avoid changing unrelated feature visuals.

8. Add focused tests.
   - Test request validation and the response shape for the new server endpoint.
   - Test creation of a new session, resumption with a supplied session ID, propagation of the SDK session ID, usage counters, and invalid-session errors using a mocked/injected Copilot client rather than a live Copilot request.
   - Test that route errors use the expected status/code/message contract.
   - Keep client type/response validation covered by the build since no browser test runner currently exists.

9. Validate the feature.
   - Run `npm test` for server/API behavior.
   - Run `npm run build` for Vue, TypeScript, and route/component integration.
   - Manually verify a first message creates a session, subsequent messages reuse it, metadata starts hidden, `more` toggles it, and a mismatched session forces a refresh.

## Error and Session Rules

- No supplied session ID: create one session and return its ID.
- Supplied valid session ID: verify it with the Copilot SDK session lookup, then resume that exact conversation; never replace it with a new session.
- Supplied invalid session ID: when the SDK lookup returns no session, return an explicit invalid-request response instructing the client to refresh.
- Client-side returned ID differs from its stored ID: treat it as a wrong request and reload the page.
- Upstream authentication, model, timeout, and malformed-output failures must retain the existing explicit error handling; do not add broad catches or success-shaped fallbacks.

## Acceptance Criteria

1. The feature is reachable from the existing hub at `/features/hello-speech`.
2. A user can submit text and see their message on the right and the bot response on the left.
3. The first response establishes a session ID, and every later request sends that same ID.
4. The server resumes valid sessions and rejects unknown sessions instead of silently starting a new conversation.
5. Every successful response includes bot text, session ID, model, duration, and all four token counters.
6. Usage metadata is hidden initially and revealed only when the user activates `more`.
7. Session mismatches and invalid requests produce an explicit wrong-request state and refresh behavior.
8. No speech/audio implementation, Copilot credential, or unvalidated HTML is exposed to the browser.
