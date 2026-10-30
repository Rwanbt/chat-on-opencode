# ADR-0003: Personal activation remains NO-GO

- **Status:** Accepted, amended 2026-10-30 (evidence state only — no lock, flag or verdict changed)
- **Date:** 2026-10-29 (amended 2026-10-30)
- **Deciders:** provider maintainer, repository CI policy

## Context

The provider can be functionally complete and still must not be activated in a maintainer's
personal OpenCode installation. That is not caution for its own sake: four independent
mechanisms encode the refusal, and one of them fails the repository's own CI.

`packages/opencode-provider/ACTIVATION_DECISION.md` records the full dossier. The four locks:

| # | Lock | Location | Effect |
| --- | --- | --- | --- |
| 1 | CI gate | `.github/workflows/provider-canonical-candidate.yml:39` | exits non-zero if `activationAuthorized !== false` or `promotionAllowed !== false` |
| 2 | No live promotion contract | `packages/opencode-provider/OFFICIAL_UPGRADE_NO_GO.md:49-59` | there is no supported path to a live promotion |
| 3 | Human attestation ceiling | `src/human-draft-attestation.mjs:30` | returns `REVIEW_ATTESTED_ONLY`, never an activation |
| 4 | Preflight by construction | `src/context-overlay/activation-preflight.mjs:173-176` | pushes `NO_GO` |

A fifth, non-code condition is missing evidence rather than policy. **That condition is now
partly satisfied, and the earlier wording of it was wrong.** An authentic ChatGPT qualification
has been performed for the scope the coding loop exercises (issue #113, closed): the user's own
account answered, OpenCode executed a real tool call under its own permission policy, and the
loop `read → patch → shell → answer` completed end to end on a disposable fixture in an isolated
profile. What remains unqualified is narrower, and is stated as it is: the **Desktop GUI** scope
is still synthetic (no real account has driven the official Desktop GUI), a standalone real
*text* turn is not recorded as a qualification record in its own right, and multimodal parity
and unattended inference remain unqualified. No Desktop proof to date is authentic.

## Decision

Personal activation stays **NO-GO** until all of the following are true, in this order:

1. a live promotion contract exists and is reviewed;
2. an authentic qualification has produced durable evidence for the scope being activated, with
   the user's own account and explicit authorisation — **satisfied for the CLI/coding scope
   (issue #113, closed), open for the Desktop GUI scope**;
3. the human attestation path can express activation rather than only review;
4. a human explicitly authorises the transition.

Until then: `promotionAllowed` and `activationAuthorized` stay `false`, no personal installation
is modified, and no claim of "activated" is made. Functional capability (ADR-0001, ADR-0002) does
not imply permission to activate.

## Consequences

- A green capability milestone cannot be reported as an activation milestone.
- An authentic proof for one scope (the CLI/coding loop) does not qualify another scope (the
  Desktop GUI), and it lifts no lock. The verdict is unchanged by this amendment.
- The CI gate stays meaningful; flipping the flags to "make it work" would break the repository's
  own pipeline and is therefore never a shortcut.
- Work on real coding proceeds in disposable profiles and annex branches, never in the personal
  installation.

## Alternatives considered

- **Activate now and document the risk.** Rejected: it violates lock 1 and would fail CI by
  construction; it would also require the user's credentials, which must never be copied.
- **Treat synthetic Desktop acceptance as authentic qualification.** Rejected: synthetic scope
  proves the transport renders text; it proves nothing about a real account, model or tool call.
- **Treat the authentic CLI/coding proof as an activation qualification.** Rejected: it is a
  capability proof of one run, in a disposable profile, on an isolated configuration. It
  authorises nothing, it touches no lock, and it says nothing about the Desktop GUI scope.

## Evidence

- `packages/opencode-provider/ACTIVATION_DECISION.md` — the citation-verified dossier.
- The four locations above, each re-read in the current tree on 2026-10-29 and again on
  2026-10-30. All four are unchanged by this amendment.
- `docs/evidence/desktop-2.1.4-57e073b.md` — synthetic acceptance, explicitly scoped.
- Issue #113 (closed) — the authentic CLI/coding qualification: the user's own account, real
  inference, and real tool calls executed by OpenCode on a disposable fixture; the fixture
  really changed and the test was re-run independently (`all assertions passed`, exit 0).
  Durable record: `docs/evidence/live-coding-smoke-2026-10-29.md` (gitignored, ADR-0004);
  reproducible harness: `packages/opencode-provider/scripts/coding-smoke/`.
- Desktop GUI acceptance re-run on 2026-10-30 at `b9233a0` against a disposable extraction of
  the official 2.1.4 build: exit 0, receipt
  `{"verified":"ACTUAL_OFFICIAL_GUI_GENERATED_RENDER","modelId":"chat-on-opencode/chatgpt-default","coldA":"A","coldB":"B","hotB":"B","onlyTestOwnedWindows":true,"personalProfilesUntouched":true}`
  and `ACTUAL_OFFICIAL_GUI_SAME_SESSION_MULTITURN_SYNTHETIC=PASS` — a **synthetic** scope.
- `docs/OPEN-OBJECTIVES.md` — the objective register (O-1…O-9) and the open caveats (#112, #118).

## Revisit trigger

Revisit only when a live promotion contract has been reviewed **and** an authentic qualification
has produced durable evidence for the scope being activated. The CLI/coding scope has produced
such evidence (issue #113, closed); the Desktop GUI scope has not. A code change alone never
satisfies this ADR.
