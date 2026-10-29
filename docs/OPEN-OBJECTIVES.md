# Open objectives - chat-on-opencode provider

The durable objective register for the `chat-on-opencode` provider. **GitHub Issues are the
canonical active work state**; this file is the index that says which objective maps to which
issue, which ADR records the decision behind it, and what a future session must not silently
reverse.

Last updated: 2026-10-29. Branch of record: `integration/pr62-pr63-pr64-worker2` (PR #65, Draft).

## Mission

Make `chat-on-opencode/chatgpt-default` genuinely usable for coding on a real project: the
model reads a file, proposes an edit or a command, OpenCode executes it under its own
permissions, the result returns to the model, and the task completes. This is the principle the
reference product uses, and it is the acceptance criterion (ADR-0001).

**Not the mission:** activating the plugin in a personal installation. That stays NO-GO
(ADR-0003), independently of capability.

## Decisions of record

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-0001](adr/0001-real-project-coding-is-the-acceptance-criterion.md) | Real-project coding is the acceptance criterion | Accepted |
| [ADR-0002](adr/0002-opencode-executed-text-tool-bridge.md) | Effects travel through an OpenCode-executed text→tool-call bridge | Accepted, verification pending |
| [ADR-0003](adr/0003-personal-activation-remains-no-go.md) | Personal activation remains NO-GO | Accepted |
| [ADR-0004](adr/0004-evidence-scope-and-persistence.md) | Evidence scope and persistence | Accepted |
| [ADR-0005](adr/0005-native-responses-function-calling-deferred.md) | Native Responses function calling is deferred, not abandoned | Deferred |

## Objectives

| # | Objective | Issue | State | Blocking condition |
| --- | --- | --- | --- | --- |
| O-1 | Native coding mode: the bridge itself | [#110](https://github.com/Rwanbt/chat-on-opencode/issues/110) | In progress | — |
| O-2 | Real-project coding smoke test (read → edit → run → observe) | [#111](https://github.com/Rwanbt/chat-on-opencode/issues/111) | Open | needs O-1 and O-5 |
| O-3 | Reproduce and fix the Desktop `native_new_session_button_not_found` flake | [#112](https://github.com/Rwanbt/chat-on-opencode/issues/112) | Open | local reproduction is blocked by the publisher's global process scan |
| O-4 | Authentic ChatGPT qualification | [#113](https://github.com/Rwanbt/chat-on-opencode/issues/113) | Open | needs a human: the account and an explicit authorisation |
| O-5 | Live promotion contract and activation-capable attestation | [#114](https://github.com/Rwanbt/chat-on-opencode/issues/114) | Open | needs a human decision to commission the contract |
| O-6 | Native Responses function calling | [#115](https://github.com/Rwanbt/chat-on-opencode/issues/115) | Deferred | needs O-4 to qualify the route |
| O-7 | Persist the Desktop acceptance proof where it can be re-inspected | [#116](https://github.com/Rwanbt/chat-on-opencode/issues/116) | Open | — |
| O-8 | Document the coding capability, its protocol and its limits | [#117](https://github.com/Rwanbt/chat-on-opencode/issues/117) | Open | — |

## Standing constraints

These are not preferences. They are the conditions under which the work stays valid.

- PR #65 and any annex PR stay **Draft**. No merge, no force-push, `main` untouched.
- `promotionAllowed` and `activationAuthorized` stay `false`. The CI gate
  (`.github/workflows/provider-canonical-candidate.yml:39`) fails the pipeline otherwise, and the
  official activation path refuses any configuration whose `nativeTools` is not `off`.
- No personal installation, profile, browser profile, cookie, secret, token or personal log is
  read or written. Disposable copies and isolated profiles only.
- Never touch PID 7444 or any personal process. Never occupy a port that is in use.
- The official OpenCode Desktop 2.1.4 is never modified or recompiled.
- The gateway never executes a tool. OpenCode executes, under its own permissions.
- An unconfirmed flake stays in the record until it is reproduced (ADR-0004).

## Resuming in another session

1. Read this file and `docs/adr/README.md` first. They are the summary of the objective and of
   the decisions that must not be silently reversed.
2. Read `packages/opencode-provider/ACTIVATION_DECISION.md` for the activation dossier and its
   four locks.
3. Check the open issues: #110 to #117 carry the acceptance criteria and the evidence each one
   requires.
4. Verify the current state before acting: `git log --oneline -5`, `npm test --prefix
   packages/opencode-provider`, and the CI runs for the head commit.

## Known open caveat

The Desktop acceptance step passed twice at `57e073b`, but the root normalisation added in that
commit never fired in either run (no `OWNED_RENDERER_ROOT_NORMALISED` marker), so the cause of
the intermittent `native_new_session_button_not_found` failure is still **unconfirmed**. Two green
runs of a ~50 % flake are not evidence of a fix. This is tracked by #112.
