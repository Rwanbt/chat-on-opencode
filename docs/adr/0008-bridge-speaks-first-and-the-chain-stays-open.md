# ADR-0008: The bridge speaks first, and every turn may carry the next tool call

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0002 (the bridge; its revisit trigger fired), ADR-0004 (evidence scope),
  ADR-0006 (bridge composition)

## Context

ADR-0002 chose the ownership boundary — the gateway translates text into a `tool_calls` entry,
OpenCode executes it — and left the *protocol* open to evidence. Two live failures against a real
ChatGPT account then showed that the protocol, not the boundary, was the limiting factor.

**1. The model refused the task instead of asking for a tool.** In a live run the model answered
the task in prose:

> Impossible de modifier `sum.js` et de vérifier le test : la connexion locale Chat On Steroids
> est interrompue (`Tunnel-client not seen for 300 seconds`).

That status is the **ChatGPT-side connector's** own heartbeat. It describes a channel this bridge
does not use: the bridge reaches the model through the CoS control API and carries the effect back
as a tool call. The connector's health says nothing about the bridge's access, and the model
treated it as a blocker. The refusal was intermittent — other runs produced the envelope — but a
bridge whose first answer may be a refusal is not usable.

**2. The coding chain stopped after the first tool.** The model produced the `read` envelope, the
tool ran, the result came back, and the model produced the next envelope (`patch`). The gateway
never converted it: a turn that carries a tool result skipped the envelope analysis entirely
(`src/gateway.mjs`, `result ? null : parseCodingCall(...)`), so the second envelope of the chain
fell back to prose and the loop ended after one tool.

The second failure was a plain defect and is fixed by the rule below. The first is a protocol
failure and is fixed by the protocol below. Neither touches the ownership boundary.

## Decision

**A. The bridge speaks first.** A bridge turn is composed as: protocol → worked example → exact
tool manifest → project context → the task, labelled `Task to carry out:`. The model meets the
contract before the request that needs it, and never meets OpenCode's native preface (ADR-0006).

**B. The protocol names the stale status and refuses it.** The protocol states that the tools
listed below are the model's access and that they are working now; that a connector status such as
`Tunnel-client not connected` or `Tunnel-client not seen for 300 seconds` is stale text about the
ChatGPT-side connector that does not describe this access; and that the model must never answer
that a task is impossible, blocked or that a connection is down. If a tool is needed, the answer is
the envelope; the tool result is what says what really happened.

**C. Every turn may carry the next tool call.** The envelope analysis runs on *every* answer,
including a turn that carries a tool result. A tool result is folded back as untrusted data and the
chain continues with the next envelope. The tool-result prompt is composed **lazily**, so a turn
holding a `tool` role is never read as a task and never fails with `unsupported_chat_content`.

**D. The call id carries the chain step.** The id is derived from the session, the native message,
the *step of the chain* and the answer text. The same envelope may legitimately be asked twice in
one chain (run the tests, fix, run them again): without the step, both steps would share one call
id and the native transcript could no longer pair tool results to calls.

## Consequences

- The chain read → edit → run → observe → answer can span as many native turns as the task needs;
  each turn carries at most one envelope, and each envelope becomes exactly one `tool_calls` entry.
- A tool-result turn is composed from the tool's own prompt, never from the task history, so a
  `tool` role can never be mistaken for a user instruction.
- The protocol carries two explicit sentences about the connector status. They are true: the
  bridge's access is the manifest, and the connector's heartbeat is about another channel.
- The model's first answer may still be prose. When it is, the bridge returns it as prose — it
  never fabricates a tool call and never downgrades an envelope into text.

## Alternatives considered

- **Ignore the connector status in the model view.** Not available: the status is injected by
  ChatGPT's product layer, not by this provider. The bridge can only state, in its own prompt, that
  the status does not describe its access.
- **Bring the ChatGPT-side connector up.** The connector needs a tunnel id and an OpenAI tunnel API
  key (`src/main/tunnel/index.ts:321`). It also belongs to the account, not to the disposable
  profile, and the personal instance is out of scope by ADR-0003.
- **Execute the tool inside the gateway when the model refuses.** Rejected: it moves permission
  ownership away from OpenCode and is exactly the effect path ADR-0002 refuses.
- **Let the model answer prose and treat the task as done.** Rejected: it is the failure this ADR
  exists to remove.
- **Keep one call per native turn.** Rejected: a coding task needs more than one effect, and one
  call per *answer* keeps identity, replay and custody deterministic without freezing the chain.

## Evidence

- `src/native-tools.mjs` — `codingInstructions` (the protocol, the worked example, the manifest,
  the connector-status rule), `codingResultPrompt` (the untrusted fold-back), `parseCodingCall`
  (the envelope analysis, now applied on every turn, with the chain step in the id).
- `src/native-read.mjs` — `readInstructions`, same protocol shape for the single-tool mode.
- `src/gateway.mjs` — `bridgeRequestText` (the labelled task), the lazy `composeTask`, the
  envelope analysis applied to every answer.
- `test/native-tools.test.mjs` — the deterministic coverage: a tool-result turn may issue the next
  call of the chain; a tool-result turn is answered with the tool prompt and never with a task
  composition; two identical envelopes in one chain keep distinct call ids; the protocol names the
  stale connector status.
- `test/bridge-context.test.mjs` — the composition coverage of ADR-0006.

**Evidence level.** The refusal and the stopped chain are *authentic* (live runs against the real
ChatGPT account through the isolated CoS profile). The regression tests are *synthetic* and
reproduce the same states deterministically.

## Revisit trigger

Revisit when the bridge gains a second transport, when ChatGPT stops injecting connector status
into the model view, when native function calling becomes verifiable (ADR-0005), or when the
protocol needs to carry something the manifest cannot express.
