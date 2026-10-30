# Open objectives - chat-on-opencode provider

The durable objective register for the `chat-on-opencode` provider. **GitHub Issues are the
canonical active work state**; this file is the index that says which objective maps to which
issue, which ADR records the decision behind it, and what a future session must not silently
reverse.

Last updated: 2026-10-30. Branch of record: `integration/pr62-pr63-pr64-worker2` (PR #65, Draft).

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
| [ADR-0002](adr/0002-opencode-executed-text-tool-bridge.md) | Effects travel through an OpenCode-executed text→tool-call bridge | Accepted, amended by 0006, 0008, 0009 and 0010 |
| [ADR-0003](adr/0003-personal-activation-remains-no-go.md) | Personal activation remains NO-GO | Accepted, amended 2026-10-30 (evidence state only) |
| [ADR-0004](adr/0004-evidence-scope-and-persistence.md) | Evidence scope and persistence | Accepted |
| [ADR-0005](adr/0005-native-responses-function-calling-deferred.md) | Native Responses function calling is deferred, not abandoned | Deferred |
| [ADR-0006](adr/0006-bridge-turn-carries-its-own-context.md) | A bridge turn carries the bridge's own context, not OpenCode's native preface | Accepted |
| [ADR-0007](adr/0007-control-api-port-decides-owner-liveness.md) | The control API's port, not its pid, decides whether a CoS owner is alive | Accepted |
| [ADR-0008](adr/0008-bridge-speaks-first-and-the-chain-stays-open.md) | The bridge speaks first, and every turn may carry the next tool call | Accepted |
| [ADR-0009](adr/0009-a-completed-turn-is-not-finished-until-its-final-row.md) | A completed turn is not finished until its final assistant row has been read | Accepted |
| [ADR-0010](adr/0010-chatgpt-citation-directive-is-product-metadata.md) | ChatGPT's citation directive is product metadata, not an answer | Accepted |
| [ADR-0011](adr/0011-one-cas-owner-and-an-authorisation-receipt.md) | One CAS owner, scoped edits, and an authorisation receipt | Accepted |

## Objectives

| # | Objective | Issue | State | Blocking condition |
| --- | --- | --- | --- | --- |
| O-1 | Native coding mode: the bridge itself | [#110](https://github.com/Rwanbt/chat-on-opencode/issues/110) | Implemented, live-proven | — |
| O-2 | Real-project coding smoke test (read → edit → run → observe) | [#111](https://github.com/Rwanbt/chat-on-opencode/issues/111) | Done (live, authentic) | — |
| O-3 | Reproduce and fix the Desktop `native_new_session_button_not_found` flake | [#112](https://github.com/Rwanbt/chat-on-opencode/issues/112) | Open | local reproduction is blocked by the publisher's global process scan |
| O-4 | Authentic ChatGPT qualification | [#113](https://github.com/Rwanbt/chat-on-opencode/issues/113) | Scopes 2–3 observed live | scope 1 (a standalone real text turn) is not yet recorded as such |
| O-5 | Live promotion contract and activation-capable attestation | [#114](https://github.com/Rwanbt/chat-on-opencode/issues/114) | Design written (ADR-0011, `PROMOTION_CONTRACT.md`); P1 proven | P2 (the format-2 upgrade-aware manifest) is not implemented |
| O-6 | Native Responses function calling | [#115](https://github.com/Rwanbt/chat-on-opencode/issues/115) | Deferred | needs O-4 to qualify the route |
| O-7 | Persist the Desktop acceptance proof where it can be re-inspected | [#116](https://github.com/Rwanbt/chat-on-opencode/issues/116) | Open | — |
| O-8 | Document the coding capability, its protocol and its limits | [#117](https://github.com/Rwanbt/chat-on-opencode/issues/117) | Done (documented) | — |
| O-9 | Reproduce and fix the Desktop `desktop_composer_not_uniquely_visible` flake | [#118](https://github.com/Rwanbt/chat-on-opencode/issues/118) | Open | the cause is unconfirmed; one failure in four observed hosted runs |

## Where the objectives stand

**O-1 and O-2 are proven against the authentic account.** The loop `read → patch → shell → answer`
was observed end to end against the user's own ChatGPT account, in an isolated profile, on a
disposable fixture project: the model read `sum.js`, proposed the edit, OpenCode executed it under
its own permission policy, the model ran `node sum.test.js`, observed the green output and reported
the outcome in one sentence. The fixture file really changed, and the test was re-run
independently of the model (`all assertions passed`, exit 0). The reproducible harness lives in
`packages/opencode-provider/scripts/coding-smoke/` and proves its own receipts: it re-arms the
fixture in a known RED state, records the RED exit code, lists the tool calls the native turn
actually executed, re-runs the test afterwards, and only then reports `SMOKE=PASS`.

Reaching that state required five cause-level fixes, each recorded in an ADR:

| Symptom | Cause | ADR |
| --- | --- | --- |
| the model never saw the task | OpenCode's native preface (69 896 chars) displaced the bridge's own protocol and task | 0006 |
| the endpoint was adopted while its owner was gone | liveness was decided by a pid instead of by the control API's port | 0007 |
| the model refused, then answered in prose | the protocol was not stated first, the connector status was read as a blocker, and the chain was closed after one turn | 0008 |
| the turn completed with no answer | the recorder publishes the final assistant row in the batch **after** `turn_end` | 0009 |
| a valid answer was refused as a contradiction | ChatGPT's own citation directive was held as the answer | 0010 |

**O-4 is partially observed.** The account qualification has been carried out for the scopes that
the coding loop exercises — a real account, a real model answering, a real tool call executed by
OpenCode, over a multi-turn session on a real fixture. What is not yet recorded is scope 1 as a
standalone qualification record: a real *text* turn, with the account's model answering, outside
the coding loop.

**O-5 is designed, not implemented.** The audit behind #114 found that the repository already
owns a native Win32 CAS publication mechanism, proven end to end against the actual official
Desktop 2.1.4: it hashes the destination through its own handle and publishes with one
`MoveFileExW`, it rewrites only the one owned `package` scalar, it refuses while a Desktop is
running, and it rolls back byte-exactly. What is missing is narrower than the dossier's Lock-2
wording suggests: no authorisation is bound to a publication, the format-1 manifest pins the
whole config file (so the first publication would disable the install's own verifier and
rollback), option-level promotion has no CAS owner, and the preflight has no transition path.
ADR-0011 and `packages/opencode-provider/PROMOTION_CONTRACT.md` specify the contract and its
ordered plan (P1…P6). No lock, flag or verdict changed.

**P1 is implemented and proven** (2026-10-30): `publishScopedConfigEdits` publishes scoped
edits under the same lock, quiescence census, CAS pin and native rename as the pointer
publication, which is now a thin caller of the shared owner. Its suite proves that a scoped
option edit preserves every foreign byte and is byte-exactly reversible, that a competing
edit at the last pre-rename checkpoint leaves the competitor's bytes intact, and that a moved
config, an overlapping edit, an edit that would break the JSONC, an invalid UTF-8 config, a
BOM config and a pending managed transition are each refused before a byte is written.
**P2** — the format-2 upgrade-aware manifest, without which a legitimate publication would
disable the install's own verifier and rollback — remains open.

**O-8 is documented.** `packages/opencode-provider/README.md` states the three native tool levels,
the envelope protocol, the ownership boundary, the bounds and how they fail, and the explicit
synthetic-vs-authentic boundary; it names the still-unconfirmed Desktop flake instead of omitting
it. The harness has its own README, and ADR-0006 to ADR-0010 carry the reasoning.

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
3. Check the open issues: #110 to #118 carry the acceptance criteria and the evidence each one
   requires.
4. Verify the current state before acting: `git log --oneline -5`, `npm test --prefix
   packages/opencode-provider`, and the CI runs for the head commit.

## Known open caveats

**The `native_new_session_button_not_found` flake (#112).** The Desktop acceptance step passed
twice at `57e073b`, but the root normalisation added in that commit never fired in either run (no
`OWNED_RENDERER_ROOT_NORMALISED` marker), so the cause of the intermittent failure is still
**unconfirmed**. Two green runs of a ~50 % flake are not evidence of a fix.

**The `desktop_composer_not_uniquely_visible` flake (#118).** On run `40965507394` (head `438dd4f`),
the same Desktop job failed on a *different* assertion. Its third composer-readiness check never
became ready (`observerTicks: 178`, `observedCounts: [0,1]` across its 45 s window), and the
control census taken at that moment showed a live renderer with **no** composer element — no
`textarea`, no `[contenteditable]`, no `[role=textbox]` — while three `New session` controls were
visible. The symptom is the inverse of #112's, where the composer was visible and the New session
control was missing, so the two are tracked separately and **neither cause is claimed**.

The facts that are established: one failure in four observed executions of that job (`89d7c7f`,
`045d1a5` and `a9285a0` green; `438dd4f` red); the acceptance test file
`test/provider-official-desktop-reader.e2e.mjs` is unchanged since the green run `89d7c7f`; the
provider source, plugin and tests are byte-identical from `a270c95` to `438dd4f`; the official
Desktop 2.1.4 binary is unmodified. The difference between a green and a red run is therefore not
in the provider source, the acceptance test or the binary — and the cause itself remains
**unconfirmed** (ADR-0004).
