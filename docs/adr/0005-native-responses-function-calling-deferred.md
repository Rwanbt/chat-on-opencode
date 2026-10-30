# ADR-0005: Native Responses function calling is deferred, not abandoned

- **Status:** Deferred
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0002 (the bridge this defers to)

## Context

The cleanest way for a model to request an effect is native OpenAI Responses function calling:
the model emits a structured `function_call` item, the client executes it, and the result goes
back as a `function_call_output`. The provider already has most of the receiving side.

Existing work, on branch `feat/siwc-native-tools` (worktree `chat-on-opencode-siwc-tools`,
uncommitted at the time of writing, +103/−19 in `packages/opencode-provider/plugin/native-text-http.mjs`):

- `nativeInference` accepts `'text'` and `'tools'`;
- request validation accepts `function_call` and `function_call_output` items;
- `validateTools` bounds the declared tool list and its names;
- `validateToolChoice` constrains the choice;
- a per-turn `WeakMap` records the tools actually declared for that turn;
- the response is verified against those declared tools.

`packages/opencode-provider/src/responses-adapter.mjs` already parses `function_call` items and
enforces the allowed set (`tool_not_authorized`).

Two things block it:

1. **Configuration.** `src/config.mjs` accepts only `['off','text']` for `nativeInference` and
   only ever emits `nativeOAuth: 'preview'` with `nativeInference: 'text'`.
2. **Qualification.** The route requires an authentic account credential. This environment has
   no account, and the maintainer's credentials must never be copied. The work therefore cannot
   be verified here, and an unverifiable transport cannot be the foundation of ADR-0001.

## Decision

Defer the native function-calling route and keep ADR-0002's text→tool-call bridge as the
supported path to real project coding.

The work is **not** discarded. It stays on `feat/siwc-native-tools` with its rationale, so a
later session can resume it rather than restart it.

## Consequences

- Coding capability today depends on the model following an envelope instruction rather than on
  a structured API contract. ADR-0002's fail-closed rules are what make that acceptable.
- Two bridges may eventually coexist. The ownership boundary (OpenCode executes, the provider
  only proposes) is identical in both, so the boundary is not at risk.
- The deferred branch is not merged and not on any release path.

## Alternatives considered

- **Build both and pick at runtime.** Rejected: an unverifiable path cannot be honestly
  supported, and dual paths double the surface that must fail closed.
- **Drop the work.** Rejected: it is the natural successor if the text bridge's reliability is
  ever shown to be insufficient in a real project run.

## Evidence

- Branch `feat/siwc-native-tools`, worktree `chat-on-opencode-siwc-tools`.
- `packages/opencode-provider/src/responses-adapter.mjs` — existing `function_call` parsing and
  `allowedTools` enforcement.
- `packages/opencode-provider/plugin/native-text-http.mjs` — the deferred implementation.

## Revisit trigger

Revisit when an authentic account is available for qualification in an isolated profile, or when
a real-project run shows the envelope protocol is insufficient.
