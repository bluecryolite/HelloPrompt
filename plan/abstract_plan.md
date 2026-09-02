# Extensible Feature Hub and Copilot Service Refactor Plan

## Problem and Approach

The application currently renders the 24-game experience directly from `App.vue`. Its server module `src/server/copilot.ts` also combines reusable GitHub Copilot SDK lifecycle and request logic with 24-game prompt construction, response parsing, and solution validation.

Refactor the client into a feature hub with a home page, route-based navigation, and an isolated 24-game feature component. On the server, split the generic Copilot API client service from the 24-game solver. Keep all 24-game rules, parsing, and expression validation in feature-specific modules so future features can reuse the Copilot service without inheriting 24-game behavior.

## Target Architecture

```text
src/
  client/
    App.vue                         # Feature registry, index page, and navigation
    components/
      TwentyFourGame.vue            # 24-game UI and interaction state
    services/
      http.ts                       # Generic browser HTTP request and API-error handling
    features/
      twenty-four.ts                # 24-game API types and feature-scoped endpoint client
  server/
    app.ts                          # Express setup and feature route registration
    services/
      copilot.ts                    # Generic Copilot SDK client/session/request service
    features/
      twenty-four/
        solver.ts                   # 24-game prompt, model response handling, orchestration
        validation.ts               # 24-game input, expression, and step validation
```

## Implementation Steps

1. Add lightweight client-side navigation in `src/client/App.vue`.
   - Represent available features in a typed registry containing the 24-game feature's identifier, title, description, and path.
   - Render a feature index at `/` and navigate to a feature with the History API.
   - Handle browser back/forward navigation and unsupported paths with an explicit not-found state.
   - Avoid a routing dependency for the current single-feature scope.

2. Extract the 24-game presentation and state into `src/client/components/TwentyFourGame.vue`.
   - Move number inputs, local validation, loading timer, results, errors, and step expansion from `App.vue`.
   - Preserve current input limits, disabled controls, elapsed-time display, response rendering, and timer cleanup.
   - Keep `App.vue` focused on navigation and feature composition.

3. Separate reusable browser HTTP transport from the 24-game endpoint client.
   - Add `src/client/services/http.ts` with a typed request helper responsible only for issuing same-origin HTTP requests, parsing JSON, and converting non-success or invalid JSON responses into a typed API error.
   - Add `src/client/features/twenty-four.ts` with the 24-game request/response and result-step types, successful-response shape validation, and `solveTwentyFour(numbers)`, which calls the shared HTTP helper for `POST /features/twenty-four`.
   - Ensure `TwentyFourGame.vue` imports only the feature-specific `solveTwentyFour` operation and does not call `fetch` or contain transport parsing.
   - Do not expose credentials or call the Copilot SDK from browser code.

4. Extract the generic GitHub Copilot SDK integration into `src/server/services/copilot.ts`.
   - Move SDK client initialization, CLI resolution, data-directory setup, client reuse, model discovery/selection, request concurrency limiting, per-request session lifecycle, timeout handling, and session cleanup out of the current 24-game module.
   - Export a generic, typed operation that accepts a system instruction, prompt, optional model configuration, and a response-processing callback or returns raw model content for a feature-specific caller to validate.
   - Retain secure defaults: server-only token use, `mode: "empty"`, no available tools, isolated short-lived sessions, bounded concurrency, and explicit error codes for authentication, model selection, timeout, and upstream failures.
   - Do not import 24-game prompts, validation types, local solvers, or response schemas into this reusable service.

5. Move 24-game server behavior into `src/server/features/twenty-four/`.
   - Move `validation.ts` unchanged in responsibility: four-number input validation, exact rational-expression evaluation, solution-step validation, and local solvability search remain specific to the 24-game feature.
   - Create `solver.ts` to read the 24-game prompt, construct the 24-game system and user messages, call the generic Copilot service, strictly parse the JSON response, and invoke the 24-game validators.
   - Preserve the existing API result shape (`expression`, `formattedExpression`, `steps`, `model`) and existing `NO_SOLUTION` and invalid-model-output semantics.
   - Register `POST /features/twenty-four` in `src/server/app.ts` and wire it to the feature solver and validator rather than the former mixed `copilot.ts` module.

6. Update `src/client/style.css`.
   - Retain/reuse the current 24-game styling.
   - Add focused responsive styles for the feature index, navigation/back action, and not-found view, including accessible keyboard focus states.

7. Update and expand server tests around the new boundaries.
   - Update existing validation tests for the relocated 24-game validation module.
   - Test generic Copilot service behavior through injected or mocked SDK-facing dependencies where the project convention permits, covering model selection, timeout cleanup, and session release without requiring a real Copilot request.
   - Test the 24-game solver's handling of valid, no-solution, and malformed model responses independently from SDK transport.
   - Keep API tests asserting the feature-scoped `/features/twenty-four` status and error contract.

8. Validate the refactor.
   - Run `npm test` for server and validation behavior.
   - Run `npm run build` to type-check and bundle the refactored client.

## Files Expected to Change

| File | Change |
| --- | --- |
| `src/client/App.vue` | Become the feature index/navigation shell. |
| `src/client/components/TwentyFourGame.vue` | New extracted 24-game feature component. |
| `src/client/services/http.ts` | New reusable browser HTTP request and API-error service. |
| `src/client/features/twenty-four/api.ts` | New typed client for the 24-game solver endpoint. |
| `src/client/style.css` | Add feature-index, navigation, and fallback styles. |
| `src/server/services/copilot.ts` | New generic GitHub Copilot SDK client and request service. |
| `src/server/features/twenty-four/solver.ts` | New 24-game-specific Copilot prompt and result orchestration. |
| `src/server/features/twenty-four/validation.ts` | Relocated 24-game-specific validation and local solution logic. |
| `src/server/app.ts` | Wire the 24-game route to feature-specific modules. |
| `src/server/*.test.ts` | Update paths and add service/solver boundary tests. |
| `src/server/copilot.ts` | Remove after its responsibilities have been moved. |
| `src/server/validation.ts` | Remove after relocation and import updates. |

## Compatibility and Security Constraints

- The 24-game API is feature-scoped at `POST /features/twenty-four`; do not retain the generic `/api/solve` endpoint. Its successful result shape remains `expression`, `formattedExpression`, `steps`, and `model`.
- The root URL becomes the feature index; the 24-game page uses a stable feature URL such as `/features/24-game`.
- Express continues to serve the SPA fallback so direct visits to the feature URL work.
- Only `src/server/services/copilot.ts` owns the GitHub Copilot SDK and reads Copilot-related environment variables. Feature solvers supply feature-specific prompts and validate feature-specific outputs.
- The API service and feature components must never receive, log, or render Copilot tokens or raw unvalidated model output.
- Preserve the Chinese 24-game copy; add localized navigation labels as needed.
