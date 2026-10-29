# ADR-0004: Evidence scope and persistence

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** provider maintainer

## Context

Two failures in this mission came from evidence handling, not from code:

1. A synthetic Desktop acceptance run produced a complete proof line set that existed only as
   stdout in one session. It could not be re-inspected later, so claims about it had to be taken
   on trust.
2. A Desktop GUI step passed twice after a hardening change, but the hardening's own marker
   never appeared in either run. Reporting that as "fixed" would have been false.

Separately, `.gitignore:31` excludes `docs/evidence/`, with the comment that private local
evidence is "never release inputs".

## Decision

**Scope must be named on every claim.** Synthetic (no real account, no real inference) and
authentic (real account, real model, real tool calls) are different evidence levels. A synthetic
proof may support a transport claim; it may never support an account, model or activation claim.

**Failures stay in the record.** A flake that was not reproduced is reported as unconfirmed, with
the observed diagnostic, even when the suite is green. Two consecutive green runs of a ~50 %
flake are not evidence of a fix.

**Durable evidence lives in the repository only when the repository allows it.** `docs/evidence/`
is gitignored by policy, so Desktop acceptance records are written to disk for local inspection
and are **not** forced into git. Committed documents may cite their location and content, but
must not imply the file is part of the release input set.

**Provenance is mandatory.** Any cited proof names commit SHA, workflow run and job, and the
scope boundary.

## Consequences

- A reader can tell whether a claim was verified, and at what level.
- Evidence cannot silently become a release artefact through a `git add -f`.
- The unconfirmed Desktop flake remains visible in
  `docs/evidence/desktop-2.1.4-57e073b.md` and in `docs/OPEN-OBJECTIVES.md` (O-4), instead of
  being closed by a lucky green run.

## Alternatives considered

- **Force-add evidence to git.** Rejected: it contradicts an explicit repository policy, and the
  files may contain local paths.
- **Keep evidence only in chat.** Rejected: that is the failure mode this ADR exists to prevent.

## Evidence

- `.gitignore:31` — `docs/evidence/` exclusion and its stated rationale.
- `docs/evidence/desktop-2.1.4-57e073b.md` — a durable local record with provenance and an
  explicit unconfirmed-flake section.
- `packages/opencode-provider/ACTIVATION_DECISION.md` — the synthetic-scope boundary.

## Revisit trigger

Revisit if the repository adopts a sanctioned evidence directory that is allowed in release
inputs; the persistence rule then changes, the scope rule does not.
