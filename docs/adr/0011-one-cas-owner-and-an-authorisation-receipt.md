# ADR-0011: One CAS owner, scoped edits, and an authorisation receipt

- **Status:** Accepted; P1 (the generalised scoped-edit owner), P2 (the format-2 scoped
  manifest) and P3 (the single-use authorisation receipt) implemented and proven on 2026-10-30
- **Date:** 2026-10-30
- **Deciders:** provider maintainer
- **Relates to:** ADR-0003 (the NO-GO verdict), ADR-0004 (evidence scope)
- **Issue:** #114

## Context

ADR-0003 Lock 2 records that there is no live promotion contract, and
`packages/opencode-provider/OFFICIAL_UPGRADE_NO_GO.md:49-59` describes the missing piece as a
single-file config switch that Windows cannot make atomic-compare-and-swap.

That description was accurate about the *absence of a promotion contract*, but it understated
what the repository already contains. The audit behind issue #114 found:

1. a **native Win32 CAS publication owner** exists and is proven —
   `src/official-versioned-pointer.mjs:18-95` hashes the destination through its own handle
   with WRITE sharing denied, immediately before a single
   `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`;
2. it is exercised **end to end against the actual official OpenCode Desktop 2.1.4** —
   publish A→B, restart, B is genuinely imported and answers; publish B→A, byte-exact, and A
   answers again (`test/provider-official-desktop-reader.e2e.mjs:986-1017`);
3. its refusals are proven too — a running Desktop blocks it, and a pre-rename failure leaves
   the config unmodified (`:973-985`);
4. but it is scoped to **one plugin package path**, it is callable by **any process**, it has
   **no operator entry point**, and — decisively — the **format-1 manifest pins the whole
   config file**, so the first publication makes `inspectInstalledProvider` refuse and
   disables the install's own verifier, rollback, doctor and swap paths.

So the real gap is not "there is no CAS switch". It is: no authorisation is bound to a
publication; the manifest is not upgrade-aware; option-level promotion has no CAS owner; and
the preflight has no transition path.

The reference product (this repository's `src/main/`, Chat on Steroids) has no attestation
module, no CI gate forbidding authorisation and no preflight refusing by construction. Its
real guarantees are per-call permission checks, atomic durable writes, a digest-verified
staged update, an install rollback and a restart/quit handover — all of which the provider
already mirrors or can mirror.

## Decision

**The provider gets one CAS owner, generalised to scoped edits, and every publication is bound
to an authorisation receipt.** The full contract is in
`packages/opencode-provider/PROMOTION_CONTRACT.md`.

1. **One owner, not two.** The proven native publication owner is generalised from "one plugin
   package path" to "a set of scoped JSONC edits". The existing pointer publication becomes a
   thin caller of it. The edit computation already exists in
   `src/official-native-activation.mjs:61-99`; the publication half already exists in
   `src/official-versioned-pointer.mjs:218-244`. No second promotion mechanism is added.
2. **The manifest becomes scoped (format 2).** A format-2 install verifies its payload and
   backup exactly as today, and verifies the config by *structure* — one owned plugin
   registration and one owned provider registration — instead of by whole-file digest. A
   foreign edit elsewhere in the file neither invalidates the install nor is reverted by a
   rollback. Format 1 keeps today's strict pin; an unknown shape fails closed.
3. **An authorisation receipt is a separate artefact.** A fresh, expiring, single-use
   challenge bound to the pinned snapshot, completed by an explicit human action, yields a
   receipt that authorises *a transition*. It never performs one and never sets
   `activationAuthorized`.
4. **The honest limit is written down.** The handle must be released before `MoveFileExW`
   can replace the file, so an uncooperative writer can still race that window. The contract
   does not claim to prevent it: it bounds the window, detects a lost update afterwards
   instead of absorbing it silently, and never retries blindly.
5. **The restart handover is the parity behaviour.** The promotion takes effect at the next
   OpenCode start. Chat on Steroids hands its own update over at quit as well.

The implementation plan (P1…P6) is in the contract, each step with the proof it requires.

## Consequences

- The dossier's Lock-2 wording — "switching the active configuration to it is not
  implemented" — is imprecise: a scoped, byte-exact, CAS-checked, reversible config switch
  **is** implemented and proven against official Desktop 2.1.4. What is missing is the
  authorisation, the upgrade-aware manifest, the option scope and the transition. The lock
  itself is unchanged; only its explanation becomes accurate.
- A promotion can no longer strand the installation: format 2 is implemented and is the
  precondition for promoting at all.
- The promotion's touched-byte set is two scoped entries in `opencode.jsonc`. It never
  touches the Desktop's composer state, so the durable-draft question (B5) narrows from
  "prove the drafts durable" to "prove the promotion cannot reach them".
- `promotionAllowed` and `activationAuthorized` stay `false`. The transition refuses until
  a human authorises it, separately and explicitly (ADR-0003, decision step 4). The CI gate
  keeps failing on any artifact that claims otherwise.
- No lock is lifted by this ADR. B5 and B6 describe how a future preflight *could* be
  evidence-based; whether it becomes one is a human decision.

## Alternatives considered

- **Add a second promotion path for option-level edits.** Rejected: it would create a second
  CAS owner, a second lock discipline and a second crash-classification story for the same
  file. The existing owner already solves the hard part.
- **Make the promotion live (reload the running Desktop).** Rejected for now: the running
  Desktop holds plugin modules in memory (proved in
   `test/provider-official-desktop-reader.e2e.mjs:979-981`), and the reference product also
  hands over at quit. A restart handover is simpler, safer and parity-correct.
- **Keep the whole-file config pin and forbid any config change.** Rejected: that is the
  status quo, and it makes the install's own verifier unusable the moment a legitimate
  publication happens. It converts a proven mechanism into a forbidden one.
- **Let the attestation module express activation directly.** Rejected: an authorisation
  receipt is a different artefact from review evidence. Keeping them separate means a
  receipt can never be mistaken for a completed transition, and the existing module's
  `REVIEW_ATTESTED_ONLY` ceiling stays literally true until a human decides otherwise.

## Evidence

- `packages/opencode-provider/PROMOTION_CONTRACT.md` — the contract, its CAS rules, its
  manifest rules and its implementation plan.
- `src/official-versioned-pointer.mjs` — the existing native CAS owner, its lock, its
  refusal paths and its crash classification.
- `test/provider-official-desktop-reader.e2e.mjs:973-1017` — publication, refusal and
  byte-exact rollback against the actual official Desktop 2.1.4.
- `src/official-install.mjs:152`, `:188-190`, `:196-204` — the format-1 whole-file pin and
  the refusals it causes.
- `src/official-native-activation.mjs:16-19`, `:61-99`, `:100-105` — the option-scope edit
  computation that exists only as a preview.
- `src/context-overlay/activation-preflight.mjs:172-177` — the unconditional reason and the
  hardcoded `NO_GO`.
- `src/official-scoped-config.mjs` — the format-2 scope model: the owned plugin registration is
  identified by our own option keys **and** by a `package` under the `.chat-on-opencode-`
  namespace, never by an exact path that a publication would rewrite.
- `src/official-install.mjs` — the format-2 writer, the upgrade-aware reader and the scoped
  rollback (`EXACT_RESTORE` when the config still matches the published digest,
  `SCOPED_REMOVAL` when a foreign edit landed in between).
- `test/official-install-format2.test.mjs` — 7 tests proving the install still verifies after a
  scoped publication and after a pointer-style repoint to a digest-addressed versioned
  generation, that a foreign edit survives a scoped rollback byte for byte, that format 1 keeps
  its strict pin, that an unknown format fails closed, and that a repointed, removed or
  duplicated owned entry is refused rather than repaired.
- `src/promotion-authorisation.mjs` and `test/promotion-authorisation.test.mjs` — the P3
  receipt: a challenge is minted and recorded in a reserved authorisation directory; a receipt
  needs that recorded challenge, a human review, an idle process and an unmoved snapshot; each
  claim is an exclusive create, so one challenge yields one receipt and one receipt yields one
  publication. 11 tests cover the refusals named in the contract. The module is separate from
  `human-draft-attestation.mjs`, whose `REVIEW_ATTESTED_ONLY` semantics are unchanged.
- Local re-verification on 2026-10-30, with the provider code unchanged since `b9233a0`: the
  five pointer suites are green (13 tests, 12 pass, 1 skipped).

## Revisit trigger

Revisit when **P4** — the transition and its `bin/` entry point — is implemented and proven.
P3 is now implemented and proven: `src/promotion-authorisation.mjs` issues and consumes a
single-use receipt bound to the pinned snapshot, through exclusive-create claims in a reserved
authorisation directory, and it authorises a transition without performing one. P1 and P2 are
also proven: `publishScopedConfigEdits` publishes scoped edits under the same owner, lock, CAS
and native rename as the pointer publication, and the format-2 manifest verifies the config by
scoped ownership instead of a whole-file digest. The transition is the first piece that can
*publish*, so it needs the sharpest review, and it must still refuse while `promotionAllowed`
is `false`. Revisit earlier only if the official OpenCode exposes a supported live-reload API, which would change
the restart-handover decision.
