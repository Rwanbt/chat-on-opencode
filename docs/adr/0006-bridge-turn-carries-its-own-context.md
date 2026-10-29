# ADR-0006: A bridge turn carries the bridge's own context, not OpenCode's native preface

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0002 (the bridge), ADR-0004 (evidence scope)

## Context

A tool-bridge turn is not an OpenCode native turn. On the far side of the bridge there is no
harness, no native tool syntax and no skills catalogue: there is a ChatGPT conversation that
receives text and answers with text. The bridge therefore has to carry two things to the model —
the **exact tool contract** the model may use, and the **task** — and nothing else.

The first implementation forwarded OpenCode's whole request, native system preface included, and
then appended the bridge's own tool instructions. On a realistic profile that double-counted the
tool contract and overflowed the CoS envelope:

| Measurement (live OpenCode 2.1.4, build agent, disposable profile) | Value |
| --- | --- |
| Raw HTTP request body | 85 510 characters |
| OpenCode native system message | 69 896 characters |
| … of which the `## Available tools` section | 66 735 characters (95.5 %) |
| User task message | 407 characters |
| Structured tool definitions (11 tools) | 11 774 characters |
| CoS envelope ceiling (`POST /v1/inputs`, `src/main/control-actions.ts:43`) | 64 000 characters |

The failure was **fail-closed and correct**: the turn was refused with `cos_input_too_large`
(413) before anything reached ChatGPT. It was also a *product* failure — the bridge was unusable
on any realistic profile.

The root cause is a duplicated contract. The `## Available tools` section is OpenCode's own prose
description of the native tool-calling environment; the bridge already states the same contract
precisely, as the structured manifest it forwards (`src/native-tools.mjs`, `codingInstructions`).
Forwarding both spends 95 % of the envelope repeating what the model already has.

Two further facts constrained the fix:

- The native preface cannot be rewritten in place. The `context` hook exposes `event.system` as
  an **array of objects**; replacing it with strings makes OpenCode 2.1.4 fail with
  `Schema validation failed`.
- The project directory is native context the bridge cannot reconstruct. OpenCode resolves
  relative tool arguments against it, and the read contract asks for absolute paths.

## Decision

**In the bridge modes (`read`, `coding`), the gateway composes the CoS input itself** — the
bridge's protocol, the exact tool manifest, the project directory and the task. It does **not**
forward OpenCode's native system preface.

**Plain text mode (`nativeTools: 'off'`) is unchanged.** There the model *is* the native agent
answering in prose, so the native preface is the prompt and must keep crossing the bridge.

**The project directory is carried explicitly.** The plugin is the OpenCode-side owner of that
fact: it reads `ctx.location.directory` and sends it as the `x-opencode-location` header
(`plugin/index.ts:32`, `plugin/index.ts:85`, `plugin/index.ts:94`). The gateway validates it with
`normalizeLocation` (`src/bridge-context.mjs`) and drops it if it is not a bounded absolute path.
An unusable location is **never guessed and never forwarded raw**: the turn proceeds without a
project context rather than with a fabricated one.

## Consequences

- The bridge fits the CoS envelope on a realistic profile: the admitted input is the task plus a
  bounded manifest, measured at 902 characters for the regression scenario.
- The model sees **one** tool contract, the precise one. It can no longer be confused by a
  parallel prose description of the same tools.
- A bridge turn carries less context than a native turn. That is deliberate: the native preface
  describes an environment the far side does not have. What the far side genuinely needs — the
  tool contract and where the tools resolve — is carried exactly.
- The directory travels through a header, so it is visible to the gateway as a separate,
  validated input rather than being spliced into prompt text.
- `read` mode inherits the same rule as `coding`. Both are bridge turns.

## Alternatives considered

- **Raise or bypass the CoS envelope limit.** Rejected: the limit belongs to the CoS control
  API, not to the provider, and bypassing it would push unbounded content into a channel that
  was designed to stay bounded.
- **Strip only the `## Available tools` section from the native preface.** Rejected: it requires
  parsing and editing OpenCode's own prompt text, which is version-specific, fragile, and still
  forwards a native contract that does not apply to the far side.
- **Rewrite `event.system` in the `context` hook.** Rejected: measured — OpenCode 2.1.4 rejects
  a string replacement with `Schema validation failed`.
- **Forward the preface and drop the bridge's own manifest.** Rejected: the prose contract is
  neither bounded nor precise, and the bridge needs an exact list to validate the envelope
  against (`native_tool_envelope_invalid` otherwise).

## Evidence

- `src/gateway.mjs:30` — `bridgeRequestText`, the bridge's own composition.
- `src/gateway.mjs:39` — `requestText`, the unchanged plain-text composition.
- `src/gateway.mjs:135` — the mode selection between the two.
- `src/gateway.mjs:370` — the validated `x-opencode-location` read.
- `src/bridge-context.mjs` — `normalizeLocation`, `bridgeContextLine`, `MAX_LOCATION`.
- `plugin/index.ts:32` — the plugin's ownership of the project directory.
- `src/main/control-actions.ts:43` — the 64 000-character CoS ceiling.
- `src/main/control-reads.ts:48` — the 4 000-character cap, which applies to read projections
  only and never to the bridge input.
- `test/bridge-context.test.mjs` — the deterministic regression coverage: the native preface
  does not cross the bridge, a 70 000-character native prompt cannot overflow the envelope, the
  plain-text mode keeps its preface, and an unusable location is dropped.

**Evidence level.** The measurements above are *authentic* (a live OpenCode 2.1.4 CLI turn
against the isolated CoS profile with a real ChatGPT session). The regression test is
*synthetic* (it reproduces the measured sizes deterministically). No claim is made here that the
end-to-end coding loop has completed on a real project; that is O-2 / issue #111.

## Revisit trigger

Revisit when OpenCode's native tool contract changes shape, when the bridge gains a second
transport that needs the native preface, or when a future CoS envelope carries structured
context instead of text.
