# ADR-0003: Personal activation remains NO-GO

- **Status:** Accepted
- **Date:** 2026-10-29
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

A fifth, non-code condition is missing evidence rather than policy: no authentic ChatGPT
qualification has been performed. Every Desktop proof to date is synthetic — no real account, no
real model inference, no tool calls, no multimodal parity.

## Decision

Personal activation stays **NO-GO** until all of the following are true, in this order:

1. a live promotion contract exists and is reviewed;
2. an authentic qualification runs in an isolated profile, with the user's own account and
   explicit authorisation;
3. the human attestation path can express activation rather than only review;
4. a human explicitly authorises the transition.

Until then: `promotionAllowed` and `activationAuthorized` stay `false`, no personal installation
is modified, and no claim of "activated" is made. Functional capability (ADR-0001, ADR-0002) does
not imply permission to activate.

## Consequences

- A green capability milestone cannot be reported as an activation milestone.
- The CI gate stays meaningful; flipping the flags to "make it work" would break the repository's
  own pipeline and is therefore never a shortcut.
- Work on real coding proceeds in disposable profiles and annex branches, never in the personal
  installation.

## Alternatives considered

- **Activate now and document the risk.** Rejected: it violates lock 1 and would fail CI by
  construction; it would also require the user's credentials, which must never be copied.
- **Treat synthetic Desktop acceptance as authentic qualification.** Rejected: synthetic scope
  proves the transport renders text; it proves nothing about a real account, model or tool call.

## Evidence

- `packages/opencode-provider/ACTIVATION_DECISION.md` — the citation-verified dossier.
- The four locations above, each re-read in the current tree on 2026-10-29.
- `docs/evidence/desktop-2.1.4-57e073b.md` — synthetic acceptance, explicitly scoped.

## Revisit trigger

Revisit only when a live promotion contract has been reviewed **and** an authentic qualification
has produced durable evidence. A code change alone never satisfies this ADR.
