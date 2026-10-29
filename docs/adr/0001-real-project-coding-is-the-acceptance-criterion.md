# ADR-0001: Real-project coding is the acceptance criterion

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** product owner (explicit instruction), provider maintainer

## Context

The provider `chat-on-opencode/chatgpt-default` routes OpenCode's inference through a ChatGPT
conversation and returns text. It has passed an extensive synthetic acceptance suite: 275 tests,
and a real signed OpenCode Desktop 2.1.4 renderer that displays generated text, including
same-session follow-up and a cold A/B versioned pointer restart.

None of that proves the plugin can be used to work on a codebase. The product owner defined the
acceptance criterion directly:

> "Complètement fonctionnel veux dire que je peux utiliser ce plugin pour coder sur un projet
> réel."

> "Chat on steroids permet de coder directement sur un projet concret c'est ce principe qu'il
> faut reprendre."

The reference product achieves this because ChatGPT reads and edits files, runs commands and
observes results inside the user's project. Our provider, by contrast, advertised a single
native tool: `src/native-read.mjs:20-23` accepts exactly one declared function named `read` and
rejects everything else with `native_tool_not_allowlisted`. A model that can read but cannot
write or execute cannot code; it can only dictate text a human must apply by hand.

## Decision

The definition of done for this provider is a **real coding loop on a concrete project**:

1. the model reads a file from the project,
2. proposes an edit or a command,
3. OpenCode executes it under its own permission policy,
4. the result returns to the model,
5. the model continues until the task is finished.

Synthetic text rendering remains a necessary regression gate, but it is explicitly **not
sufficient** to call the plugin usable. Any future claim of "functional" must name which of
these five steps was actually observed and in which environment.

## Consequences

- Capability work is prioritised over further synthetic polish.
- Tests must cover the tool loop, not only text delivery.
- Activation and promotion remain a separate decision (ADR-0003); being able to code does not
  authorise personal installation.
- A demo that only prints generated prose can no longer be reported as "usable for coding".

## Alternatives considered

- **Keep text-only and document the limitation.** Rejected: it contradicts the stated product
  requirement, and the limitation is a missing capability, not a policy choice.
- **Claim parity with the reference product's MCP path.** Rejected: the reference product's
  ChatGPT client itself hosts the MCP connection (`AGENTS.md` §1: the app "supplies local tools
  over MCP"). Our transport is a text channel into a ChatGPT conversation; there is no client
  on the model side that could open an MCP connection. The transferable part is the *outcome*
  (effects on the real project), not the transport.

## Evidence

- `packages/opencode-provider/src/native-read.mjs:20-23` — the single-tool allowlist.
- `packages/opencode-provider/plugin/text-only.mjs` — the context gate that deletes every tool
  except `read`.
- `packages/opencode-provider/ACTIVATION_DECISION.md` — the synthetic-scope boundary.

## Revisit trigger

Revisit if the transport gains a model-side client able to host MCP or native function calling
without an unverifiable credential, in which case ADR-0002's bridge becomes one option among
several rather than the only viable one.
