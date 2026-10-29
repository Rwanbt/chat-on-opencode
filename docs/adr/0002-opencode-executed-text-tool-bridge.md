# ADR-0002: Carry effects through an OpenCode-executed text→tool-call bridge

- **Status:** Accepted, amended by ADR-0006 (composition) and ADR-0008 (protocol and chain)
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0001 (why), ADR-0005 (the deferred alternative)

## Context

ADR-0001 requires the model to obtain effects on a real project. Three transports were
available, and only one is both viable today and consistent with the existing ownership
boundaries.

1. **MCP**, as the reference product uses. Not viable here: MCP requires the *client that talks
   to the model* to host the tool connection. In the reference product that client is ChatGPT
   itself (`AGENTS.md` §1). In this provider the model side is a ChatGPT conversation reached
   through a text channel; nothing on that side can open an MCP connection.
2. **Native OpenAI Responses function calling** (`nativeInference: 'tools'`). Architecturally
   the cleanest, but it requires an authenticated account credential and is currently
   unverifiable in this environment. Deferred in ADR-0005.
3. **A text→tool-call bridge.** The provider already implements exactly this for one tool:
   `src/native-read.mjs` injects `READ_INSTRUCTIONS`, suppresses streaming, validates an
   `<opencode-read>{...}</opencode-read>` envelope, and converts it into an OpenAI-compatible
   `tool_calls` entry that OpenCode executes. This works on the proven text transport.

## Decision

Generalise the proven single-tool bridge into a bounded multi-tool bridge, selected by
`nativeTools: 'coding'`.

**Ownership.** The gateway never executes a tool. It translates a completed assistant text into
a `tool_calls` entry. OpenCode executes that call under its own permission policy and returns
the result, which is folded back into the next prompt as untrusted data. No code path in the
provider can grant an effect by itself.

**Protocol.** Exactly one call per turn:

```
<opencode-tool>{"name":"TOOL_NAME","arguments":{...}}</opencode-tool>
```

Any other answer is ordinary text.

**Bounds and fail-closed rules** (`src/native-tools.mjs`):

| Rule | Limit / behaviour |
| --- | --- |
| Declared tools | forwarded, never silently dropped (dropping a contract would misrepresent what OpenCode can execute) |
| Tool count | ≤ 32, else `native_tool_count_too_large` |
| Tool name | `^[A-Za-z0-9_-]{1,64}$`, unique, else `native_tool_schema_invalid` |
| Description | ≤ 2048 characters |
| Parameters schema | object, serialised ≤ 4096 characters |
| Manifest | ≤ 24000 characters, else `native_tools_manifest_too_large` |
| Envelope | exact `<opencode-tool>` … `</opencode-tool>`, keys exactly `arguments,name` |
| Call name | must be one of the tools declared this turn, else `native_tool_envelope_invalid` |
| Arguments | object, serialised ≤ 32768 characters |
| `tool_choice` | `auto`, `required`, or a function naming a declared tool; `none` disables tools |
| Tool result | exactly one preceding assistant call, matching id, declared name, ≤ 64000 characters, else `native_tool_result_identity_invalid` |
| Partial envelope | throws `native_tool_envelope_invalid`; never streamed as prose |
| Tool result without consent | `native_tool_result_without_consent` (403) |

**Permissions.** `nativeTools: 'coding'` emits `{ action: '*', resource: '*', effect: 'ask' }`,
so every effect requires an explicit per-call approval in OpenCode. The model proposes; the
human and OpenCode dispose.

## Consequences

- The provider gains real coding capability on the transport that already works, with no new
  credential and no new execution authority.
- Tool mode buffers output until the whole turn completes, because a half-written envelope must
  never be shown as prose. This is a deliberate UX trade-off: no progressive rendering while
  tools are enabled. `nativeTools: 'off'` and `'read'` keep their current behaviour.
- Correctness depends on the model following the envelope instruction. That is acceptable only
  because a malformed or unauthorised envelope fails closed instead of degrading into an
  unintended effect.
- `plugin/text-only.mjs` becomes mode-aware: `off` strips every tool, `read` keeps only `read`,
  `coding` keeps every declared tool.
- The bridge is a capability layer, not an activation. ADR-0003 is unaffected.

## Alternatives considered

- **Execute tools inside the gateway.** Rejected: it would move permission ownership away from
  OpenCode, duplicate its policy engine, and create an effect path no test could bound.
- **Silently drop unsupported tools.** Rejected: the model would believe an effect is
  impossible while OpenCode would in fact execute it. Existing behaviour already refuses rather
  than drops.
- **Allow parallel tool calls.** Rejected for now: one call per turn keeps identity, replay and
  custody deterministic. Parallelism can be added later without changing the envelope.

## Evidence

- `src/native-read.mjs` — the proven single-tool bridge this generalises.
- `src/native-tools.mjs` — the bounded implementation.
- `src/gateway.mjs` (`runTurn`) — mode selection, buffering, envelope conversion.
- `src/config.mjs` — `nativeTools: 'coding'`, permissions and `capabilities.tools`.
- `plugin/text-only.mjs` — the mode-aware context gate.
- `test/native-tools.test.mjs` — deterministic offline coverage of the loop and every refusal.

## Revisit trigger

Revisit when either (a) ADR-0005's native function calling becomes verifiable, or (b) a real
project smoke test shows the model cannot reliably produce the envelope, in which case the
protocol — not the ownership boundary — is what changes.
