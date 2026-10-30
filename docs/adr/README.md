# Architecture Decision Records

Durable, reviewable decisions for the `chat-on-opencode` provider. An ADR here records *why* a
boundary exists so a later session does not re-litigate it from memory or silently reverse it.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-real-project-coding-is-the-acceptance-criterion.md) | Real-project coding is the acceptance criterion | Accepted |
| [0002](0002-opencode-executed-text-tool-bridge.md) | Carry effects through an OpenCode-executed text→tool-call bridge | Accepted, amended by 0006, 0008, 0009 and 0010 |
| [0003](0003-personal-activation-remains-no-go.md) | Personal activation remains NO-GO | Accepted, amended 2026-10-30 (evidence state only) |
| [0004](0004-evidence-scope-and-persistence.md) | Evidence scope: synthetic vs authentic, and what is committed | Accepted |
| [0005](0005-native-responses-function-calling-deferred.md) | Native Responses function calling is deferred, not abandoned | Deferred |
| [0006](0006-bridge-turn-carries-its-own-context.md) | A bridge turn carries the bridge's own context, not OpenCode's native preface | Accepted |
| [0007](0007-control-api-port-decides-owner-liveness.md) | The control API's port, not its pid, decides whether a CoS owner is alive | Accepted |
| [0008](0008-bridge-speaks-first-and-the-chain-stays-open.md) | The bridge speaks first, and every turn may carry the next tool call | Accepted |
| [0009](0009-a-completed-turn-is-not-finished-until-its-final-row.md) | A completed turn is not finished until its final assistant row has been read | Accepted |
| [0010](0010-chatgpt-citation-directive-is-product-metadata.md) | ChatGPT's citation directive is product metadata, not an answer | Accepted |
| [0011](0011-one-cas-owner-and-an-authorisation-receipt.md) | One CAS owner, scoped edits, and an authorisation receipt | Accepted |

Open work that follows from these decisions is tracked in
[`docs/OPEN-OBJECTIVES.md`](../OPEN-OBJECTIVES.md) and, as the canonical active work state, in
the GitHub issues of `Rwanbt/chat-on-opencode` (#110 to #118).

## Format

Each ADR states Status, Date, Context, Decision, Consequences, Alternatives, Evidence and a
Revisit trigger. Status values: `Proposed`, `Accepted`, `Rejected`, `Deferred`, `Superseded`.

Cite symbols or file:line for every claim that a future reader could otherwise only take on
trust. Never cite a line number that has not been re-read in the current tree.
