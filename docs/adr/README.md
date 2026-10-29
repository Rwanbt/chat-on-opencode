# Architecture Decision Records

Durable, reviewable decisions for the `chat-on-opencode` provider. An ADR here records *why* a
boundary exists so a later session does not re-litigate it from memory or silently reverse it.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-real-project-coding-is-the-acceptance-criterion.md) | Real-project coding is the acceptance criterion | Accepted |
| [0002](0002-opencode-executed-text-tool-bridge.md) | Carry effects through an OpenCode-executed text→tool-call bridge | Accepted, verification pending |
| [0003](0003-personal-activation-remains-no-go.md) | Personal activation remains NO-GO | Accepted |
| [0004](0004-evidence-scope-and-persistence.md) | Evidence scope: synthetic vs authentic, and what is committed | Accepted |
| [0005](0005-native-responses-function-calling-deferred.md) | Native Responses function calling is deferred, not abandoned | Deferred |

Open work that follows from these decisions is tracked in
[`docs/OPEN-OBJECTIVES.md`](../OPEN-OBJECTIVES.md), because this repository currently has GitHub
Issues disabled.

## Format

Each ADR states Status, Date, Context, Decision, Consequences, Alternatives, Evidence and a
Revisit trigger. Status values: `Proposed`, `Accepted`, `Rejected`, `Deferred`, `Superseded`.

Cite symbols or file:line for every claim that a future reader could otherwise only take on
trust. Never cite a line number that has not been re-read in the current tree.
