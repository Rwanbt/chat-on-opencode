# Personal activation — decision record (2026-10-29, amended 2026-10-30)

Status: **NO-GO**, unchanged. This record does not authorize, perform or prepare an
activation. It documents *why* the verdict is NO-GO, which parts are closed by design
rather than by missing work, and what would have to change for a future GO.

Amended 2026-10-30: the *evidence* state recorded in §2 and §3 was stale and is corrected. The
verdict, the four locks, `promotionAllowed` and `activationAuthorized` are unchanged by this
amendment.

Scope: activating `chat-on-opencode/chatgpt-default` in the maintainer's own official
OpenCode Desktop. It is not a statement about functional readiness, which is tracked
separately below.

## 1. The verdict is refused in four independent places

Each lock below is sufficient on its own to keep the verdict at NO-GO. None of them is a
bug; each one is a deliberate refusal. A future GO requires all four to be lifted
together, in the order given.

### Lock 1 — CI fails any artifact that claims authorization

`.github/workflows/provider-canonical-candidate.yml:39` exits non-zero when the candidate
manifest does not satisfy `activationAuthorized === false && promotionAllowed === false`.
The workflow is even named `Provider canonical immutable candidate T (NO-GO activation)`.

Consequence: a manifest asserting `true` cannot pass CI. Producing such an artifact is
not a promotion, it is a red build.

Lift condition: a governance decision to change the gate, together with the contracts
required by Locks 2 and 3. This record does not propose changing it.

### Lock 2 — there is no live promotion contract

`OFFICIAL_UPGRADE_NO_GO.md:49-59` documents the missing piece precisely: on Windows,
`renameSync(tmp, opencode.jsonc)` is **not** an atomic compare-and-swap, another editor
can write between our read and our rename, and a synthetic native Windows test reproduces
that lost update. The same document states there is intentionally **no** `--promote` or
`--rollback-live` command.

Consequence: publishing a versioned candidate directory is proven; switching the active
configuration to it is not implemented, by design.

Lift condition: a qualified CAS config-switch contract **and** an upgrade-aware manifest
reader that tolerates the changed installed-config hash
(`OFFICIAL_UPGRADE_NO_GO.md:54-56`). Both are separate designs with their own proofs.

### Lock 3 — human attestation yields evidence only, never authorization

`src/human-draft-attestation.mjs:30` returns
`{ status: 'REVIEW_ATTESTED_ONLY', activationAuthorized: false, reason: 'separate_preflight_and_transition_required' }`
even when every check passes. The module comment at lines 16-18 states it "never
authorizes or performs a staged transition".

The checks it does enforce are already strict: a fresh challenge with TTL ≤ 120 s
(lines 8-9, 22), a 48-hex nonce compared in constant time (lines 23-24), explicit
`reviewedAllComposers` and `draftsSavedOrDiscarded` assertions (line 25), an idle process
(line 26), and byte-identical CAS over `config`, `journal`, `originalA`, `activeB`,
`candidateC` (lines 27-28).

Consequence: a human saying "I reviewed every composer" is recorded as review evidence.
It does not move the verdict.

Lift condition: a separate transition contract (Lock 2) that consumes this evidence.

### Lock 4 — the preflight can never return GO

`src/context-overlay/activation-preflight.mjs:173` pushes
`unsent_gui_drafts_not_proven_durable` unconditionally, with the comment that this scope
cannot see all unsent GUI composers. Line 175 hardcodes `status: 'NO_GO'` and line 176
`activationAuthorized: false`.

The other reasons it can add are equally fail-closed: unknown process/port state or a
running OpenCode (lines 122-123), an unreconciled swap journal (line 129), a pending
additive transaction (line 159), an already-installed overlay (line 171), and additive or
foreign-tree integrity conflicts (lines 143-153, 168-170).

Consequence: even a perfectly quiescent machine still reports NO_GO, because one reason
is added by construction.

Lift condition: a durable-draft contract that can actually prove unsent composers are
recoverable, plus removal of the unconditional reason — a design change, not a fix.

## 2. The evidence gap that is not a lock

*Amended 2026-10-30: the wording of this section was stale and is replaced below. The verdict
and the four locks are unchanged.*

Authentic ChatGPT qualification is **no longer missing as a whole**. It has been performed for
the scope the coding loop exercises (issue #113, closed): against the user's own account, in an
isolated profile, on a disposable fixture project, the loop `read → patch → shell → answer`
completed end to end — the model read a real file, OpenCode executed the edit and the command
under its own permission policy, the model observed the green test output and answered. The
fixture really changed and the test was re-run independently of the model (`all assertions
passed`, exit 0). The durable record is `docs/evidence/live-coding-smoke-2026-10-29.md`
(gitignored, ADR-0004); the reproducible harness is committed in
`packages/opencode-provider/scripts/coding-smoke/`.

What is still unqualified is narrower, and is stated as it is:

* the **Desktop GUI** scope is still synthetic — the official Desktop 2.1.4 acceptance is
  driven by the offline fixture, not by a real account;
* a standalone real **text** turn is not recorded as a qualification record in its own right;
* multimodal parity and unattended inference remain unqualified.

The provider's own README states the boundary explicitly at
`packages/opencode-provider/README.md:114-123`: everything the repository exercises offline is
synthetic, and the one authentic run is a **capability proof of one run** — not a
qualification of the account, and not an activation.

This remains a missing-evidence gap rather than a refusal: no code path forbids it. It requires
an authorized account and a human who performs the run. Copying personal credentials into
a test profile is explicitly out of bounds for this mission.

## 3. What is actually proven

*Amended 2026-10-30: the test count and the scope of the proofs are corrected below. No lock
is touched by this amendment.*

Functional readiness is separate from activation and is **GO** for the synthetic scope and for
the authentic CLI/coding scope:

* Multi-turn, persistence, restart recovery, replay-after-admission, Stop propagation,
  session isolation and provider switching are covered by the provider suite
  (`npm test --prefix packages/opencode-provider`: **333 tests, 328 pass, 0 fail, 5 skipped**
  at `b9233a0`, re-verified on 2026-10-30).
* Official OpenCode Desktop 2.1.4 was exercised against an isolated synthetic profile:
  first turn, same-session follow-up, cold and hot restart, and gateway-to-renderer
  correlation passed at `69882da`; the acceptance was re-run on 2026-10-30 at `b9233a0`
  against a disposable extraction of the official 2.1.4 build — exit 0, receipt
  `{"verified":"ACTUAL_OFFICIAL_GUI_GENERATED_RENDER","modelId":"chat-on-opencode/chatgpt-default","coldA":"A","coldB":"B","hotB":"B","onlyTestOwnedWindows":true,"personalProfilesUntouched":true}`
  and `ACTUAL_OFFICIAL_GUI_SAME_SESSION_MULTITURN_SYNTHETIC=PASS`. **This scope is still
  synthetic**: the model side is the offline fixture, not an account.
* The **native coding mode** is proven live against the user's own ChatGPT account, in an
  isolated profile, on a disposable fixture project: `read → patch → shell → answer`, the
  fixture really changed, and the test was re-run independently of the model (`all assertions
  passed`, exit 0). Receipt `SMOKE=PASS`; see §2 for the durable record.

Limitations to keep visible:

* that Desktop run emits its evidence to stdout and does not persist a re-readable artifact.
  The claim rests on the recorded mission log, not on a file that can be re-inspected. Any
  future GO dossier should persist those artifacts (issue #116, open).
* the Desktop acceptance job has two **unconfirmed** intermittent failures — #112
  (`native_new_session_button_not_found`) and #118 (`desktop_composer_not_uniquely_visible`),
  the latter the inverse symptom of the former. Neither cause is claimed, and neither is
  silently omitted.

## 4. What this mission must not do

* `promotionAllowed` and `activationAuthorized` stay `false`; the CI gate in Lock 1 is
  not to be edited.
* No personal installation, no promotion, no changes to `main`, no force-push.
* No contact with the maintainer's running processes, personal OpenCode install or
  profiles, browser profiles, cookies, secrets, tokens or occupied ports.
* Official OpenCode Desktop 2.1.4 is never modified or recompiled; disposable copies and
  isolated profiles only.

## 5. Decision

The personal activation verdict remains **NO-GO**. The blocker is not a defect to repair
inside this mission: it is the conjunction of an absent live-promotion contract, a
deliberately evidence-only human attestation, a preflight that refuses by construction,
and a CI gate that enforces all of it. The authentic qualification obtained since for the
CLI/coding scope changes none of those four locks; it removes one *evidence* reason and leaves
the Desktop GUI scope unqualified.

The next useful step is not more provider code. It is the reviewed design of Lock 2 — a CAS
config switch plus an upgrade-aware manifest reader (issue #114) — and the durable-draft
contract of Lock 4, each a separate reviewed design. The authentic Desktop GUI qualification
remains to be run in an isolated profile when that scope is reached.

## 6. How to re-verify this record

```sh
# Lock 1
sed -n '39p' .github/workflows/provider-canonical-candidate.yml
# Lock 2
sed -n '49,59p' packages/opencode-provider/OFFICIAL_UPGRADE_NO_GO.md
# Lock 3
sed -n '16,30p' packages/opencode-provider/src/human-draft-attestation.mjs
# Lock 4
sed -n '173,176p' packages/opencode-provider/src/context-overlay/activation-preflight.mjs
# Evidence gap (CLI/coding scope observed live; Desktop GUI scope still synthetic)
sed -n '114,123p' packages/opencode-provider/README.md
sed -n '71,75p' docs/OPEN-OBJECTIVES.md
```
