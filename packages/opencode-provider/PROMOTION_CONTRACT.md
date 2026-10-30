# Live promotion contract (design)

Status: **DESIGN**. Nothing in this document authorises a promotion, an activation or a
personal installation. `promotionAllowed` and `activationAuthorized` stay `false`, and the
CI gate that enforces it (`.github/workflows/provider-canonical-candidate.yml:39`) is not
touched by this design.

This document is the deliverable of issue #114. It states what already exists and is proven,
names the exact remaining gap, and specifies the contract that would close it — with its
atomicity rules, its fail-closed points, and the proofs each step requires.

---

## 0. What already exists, and is proven

The provider is not missing a promotion mechanism. It has one, exercised end to end against
the **actual official OpenCode Desktop 2.1.4**, and it is deliberately not exposed as an
activation API.

| Piece | Where | What it already proves |
| --- | --- | --- |
| Native Win32 CAS publication | `src/official-versioned-pointer.mjs:18-95` | the destination is hashed **through its own handle** with `FileShare.Read | FileShare.Delete` (WRITE deliberately omitted) inside the helper, and the rename is a single `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` — never a copy, never a fallback |
| Scoped byte-exact config edit | `src/official-versioned-pointer.mjs:124-152` | only the one owned `package` scalar is rewritten; comments, CRLF, trailing commas and every foreign entry survive byte-for-byte |
| Pre-rename CAS recheck | `src/official-versioned-pointer.mjs:218-244` | digest recheck, managed-transition guard, quiescence recheck, then one publication point |
| Owner lock with PID-reuse proof | `src/official-versioned-pointer.mjs:153-217` | the lock records the OS process creation timestamp; an abandoned lock is only removed after re-proving the snapshot, under a recovery marker |
| Crash classification | `src/official-versioned-pointer.mjs:281-286` | a crashed publication leaves either the old or the new complete bytes — never an intermediate state |
| Publication in the real Desktop | `test/provider-official-desktop-reader.e2e.mjs:986-1017` | publish A→B, restart the official Desktop, B is genuinely imported and answers; then publish B→A, byte-exact, and A answers again |
| Refusals proven against the live GUI | `test/provider-official-desktop-reader.e2e.mjs:973-985` | a running official Desktop blocks the publisher (`versioned_pointer_busy_or_unknown`); a pre-rename failure leaves the config unmodified |
| Payload swap with journal + rollback | `bin/official-managed-swap.mjs:114-154` | managed↔next↔previous generation swap, quiescence-checked, digest-checked, reversible |
| Content-addressed candidate publication | `src/official-upgrade.mjs:240-276` | a candidate is published under a digest-addressed sibling path by one directory rename, and can be re-inspected afterwards |

The publication is **restart-only** by construction (`status: 'RESTART_REQUIRED_ONLY'`). That
is not a shortfall against the reference product: Chat on Steroids hands its own update over
at quit as well (`src/main/update.ts:562-619`, `installerTakeover`), so a restart handover is
the parity behaviour, not a missing feature.

Local re-verification on 2026-10-30, with the provider code unchanged since `b9233a0`: the
five pointer suites are green (13 tests, 12 pass, 1 skipped).

## 1. The exact remaining gap

Six named blockers. Each one is a *missing* piece, not a broken piece.

| # | Blocker | Evidence |
| --- | --- | --- |
| **B1** | **No authorisation is bound to a publication.** `publishRestartOnlyPointer` is callable by any process; nothing requires a human to have approved that exact generation. | `src/official-versioned-pointer.mjs:248-279` |
| **B2** | **The manifest reader was not upgrade-aware, and this was the real blocker.** The format-1 manifest pinned the digest of the **whole** config file. The first publication changed that file, so `inspectInstalledProvider` then refused — which disabled the install's own verifier, its rollback, the doctor, the managed swap and the chained-swap plan. **Closed by P2** (§4). | `src/official-install.mjs:152`, `:188-190`, `:196-204`; `src/official-upgrade.mjs:60-74` |
| **B3** | **Option-level promotion has no CAS owner.** The pointer publisher only swaps the plugin package path; provider options (`nativeTools`, `nativeInference`, model id, `baseURL`) are preserved as-is by design. The only code that computes those edits is a *preview* that explicitly refuses to expose a mutation API. | `test/provider-official-desktop-reader.e2e.mjs:994-997`; `src/official-native-activation.mjs:16-19`, `:100-105` |
| **B4** | **No operator entry point.** The pointer publisher has no `bin/` command; it is reachable only from tests. | no `bin/*pointer*` exists; the only callers are `test/` and `src/` |
| **B5** | **No durable-draft contract.** The preflight pushes `unsent_gui_drafts_not_proven_durable` unconditionally. | `src/context-overlay/activation-preflight.mjs:172-176` |
| **B6** | **The preflight has no transition path.** It refuses by construction, so nothing can ever walk a promotion. | `src/context-overlay/activation-preflight.mjs:174-177` |

Two of these deserve emphasis, because they change what the work actually is:

* **B2 is the technical crux — and it is now closed.** The dossier describes the missing piece
  as "a CAS config switch". The CAS config switch already existed and is proven. What was
  missing was the **format-2 manifest**, so that a legitimate publication does not render the
  installation unverifiable. Without B2, every promotion would strand the install's own
  rollback. P2 implements it (§4, §9).
* **B5 is over-broad as written.** A promotion rewrites two scoped entries inside
  `opencode.jsonc`. Unsent GUI composers live in the Desktop's own state, not in that file.
  The contract therefore does not need to *prove drafts durable*; it needs to state exactly
  which bytes it touches and to refuse anything wider.

## 2. Objects and ownership

| Object | Owner | Mutability |
| --- | --- | --- |
| `opencode.jsonc` | the user | shared; the provider may only rewrite its own scoped entries |
| the plugin registration (`plugins[].package`) | the provider | rewritten by a publication, under the CAS owner |
| the provider registration (`providers["chat-on-opencode"]`) | the provider | rewritten by a publication, under the CAS owner |
| `.chat-on-opencode-managed/` | the provider | payload, swapped with a journal |
| `.chat-on-opencode-version-<sha>/` | the provider | immutable published candidate |
| every other byte of the config, every other provider, every other plugin | the user | never read for decision, never written |

## 3. The contract

### 3.1 One CAS owner, two edit scopes

The design does **not** add a second promotion mechanism. The proven native owner
(`src/official-versioned-pointer.mjs`) is generalised from "one plugin package path" to
"a set of scoped JSONC edits", and the existing pointer publication becomes a thin caller of
it. The edit computation already exists in `src/official-native-activation.mjs:61-99`; the
publication half already exists in `src/official-versioned-pointer.mjs:218-244`. The contract
joins them. **P1 implements this generalisation; P2 (the format-2 manifest) now exists and is
proven — see §4 and §9.**

### 3.2 The transition, in order

| Step | Action | Writes | Fail-closed point |
| --- | --- | --- | --- |
| 0 | **Preflight** (read-only): reconcile every journal, prove quiescence, verify the payload and the scoped entries, issue the attestation challenge | nothing | any unknown state, any live owner, any pending transition → refuse |
| 1 | **Authorisation**: the human asserts, through an explicit action, that they reviewed every composer and that drafts were saved or discarded, for this exact snapshot | nothing | the challenge is expired, reused, or the snapshot moved → refuse |
| 2 | **Stage**: materialise the candidate as a content-addressed directory and publish it under a digest-addressed sibling path | new directory only | digest mismatch, unsafe path, existing publication → refuse |
| 3 | **Snapshot**: pin the exact bytes of the config, the scoped entries, the active generation and the candidate generation | nothing | any pinned value that cannot be re-verified → refuse |
| 4 | **Publish**: one scoped-edit publication under the native CAS owner, with the lock, the pre-rename recheck, the quiescence recheck and the single `MoveFileExW` | the config, once | a competing edit is detected → the competitor's bytes survive untouched, the publication aborts |
| 5 | **Record**: write the promotion receipt (digests, authorisation id, generation ids) and extend the manifest lineage | manifest lineage | an unwritable lineage → refuse before step 4, never after |
| 6 | **Handover**: the new generation becomes effective at the next OpenCode start; the previous generation stays on disk and remains selectable | nothing | — |

The order matters: **every write happens after every check**. There is exactly one
irreversible point (step 4), and it is a single rename over a file that is either the old
complete bytes or the new complete bytes.

### 3.3 The CAS rules

* **C1 — one owner.** A publication runs under the existing lock
  (`.chat-on-opencode-versioned-pointer.lock`), whose owner record binds the PID to the OS
  process creation timestamp, so PID reuse cannot be mistaken for liveness.
* **C2 — pinned snapshot.** The config digest, the scoped-entry digests and both generation
  digests are pinned before the first write and re-verified before the publication.
* **C3 — handle-level conditional hash.** The destination is hashed through its own handle
  with WRITE sharing denied, immediately before the rename. A changed digest aborts the
  publication with `native_cas_changed`.
* **C4 — narrow, declared residual window.** The handle is released before the rename
  because `MoveFileExW` cannot replace a file that is open. An uncooperative writer can
  therefore still race that window. **The contract does not claim to prevent it**; it
  claims that the window is bounded, that the pre-rename recheck covers everything before
  it, and that a lost update is detected afterwards rather than absorbed silently.
* **C5 — detect, never absorb.** After the publication, the config is re-read. If it is not
  the intended bytes, the publication is reported as failed and the user's bytes are
  restored from the durable pre-image. A silent loss is not an acceptable outcome.
* **C6 — no blind retry.** A failed publication is never retried. Recovery is a separate,
  explicit operation, because a retry after an unknown outcome can publish twice.
* **C7 — no multi-file transaction.** The payload swap and the config publication are two
  operations with two journals. The contract never claims them to be one atomic unit; the
  chained-swap plan (`src/official-chained-swap-plan.mjs:60-124`) is the read-only proof of
  that limitation and stays `NO_GO_CHAINED_SWAP_NOT_ATOMIC`.
* **C8 — unknown state is a refusal.** An unreadable journal, an unknown manifest shape, a
  foreign file in a reserved path, a non-zero process count — all refuse.
* **C9 — the flags are never written by this contract.** `promotionAllowed` and
  `activationAuthorized` are inputs, not outputs. Flipping them is a separate, explicitly
  authorised act, and the CI gate keeps failing until it happens.

### 3.4 What is promised, and what is not

**Promised:** the config is never left torn; a foreign edit is never silently overwritten; a
publication is attributable to an authorisation; the previous generation remains selectable;
a crash leaves one of two complete states; every refusal is explicit and machine-readable.

**Not promised:** that an uncooperative writer cannot race the final handle-release window
(C4); that the promotion takes effect without an OpenCode restart; that a promotion
authorises unattended inference or any unattended use.

## 4. The upgrade-aware manifest (format 2)

Format 1 pins the whole config file, which is why the first publication invalidates the
install's own verifier (B2). Format 2 replaces that pin with **scoped ownership**.

```json
{
  "format": 2,
  "config": "…/opencode.jsonc",
  "backup": "…/opencode.jsonc.chat-on-opencode.<uuid>.bak",
  "originalSha256": "<sha256>",
  "installedSha256": "<sha256>",
  "payloadSha256": "<sha256>",
  "version": "2.1.4",
  "scope": {
    "providerKey": "chat-on-opencode",
    "modelKey": "chatgpt-default",
    "pluginOptionKeys": ["runtimeExecutable", "runtimeData", "nodeExecutable", "port"]
  },
  "lineage": [
    { "at": "2026-10-30T…Z", "configSha256": "<sha256>", "generation": "<sha256>", "authorisation": "<uuid>" }
  ]
}
```

The scope deliberately holds **no path**. The plugin package path is precisely what a
publication rewrites, so pinning it in the manifest would re-create the very invalidation
format 2 exists to remove, and would demand a second manifest write after every publication.

Rules:

* **R1 — the reader accepts format 1 and format 2, and nothing else.** A format-1 install
  keeps today's strict whole-file pin, so existing behaviour does not change. An unknown
  format fails closed with `provider_manifest_shape_unknown`.
* **R2 — format-2 verification is scoped.** The payload digest and the backup digest are
  verified exactly as today; the config is verified by *structure*, under two independent and
  stable conditions: exactly one plugin registration whose `options` object declares our own
  option keys (`runtimeExecutable`, `runtimeData`, `nodeExecutable`, `port`) **and** whose
  `package` points at a direct child of the config directory named `.chat-on-opencode-*`; and
  exactly one `providers[scope.providerKey]` entry declaring `scope.modelKey`. The package
  condition is a *namespace*, not an exact path: every publication target the provider owns
  lives there (`.chat-on-opencode-managed`, `.chat-on-opencode-directory-next` /
  `-previous`, `.chat-on-opencode-version-<sha>`), and a repointed entry outside it is refused
  rather than repaired. A foreign edit anywhere else in the file is irrelevant and does not
  invalidate the install.
* **R3 — a foreign edit is preserved, not reverted.** `rollbackProvider` in format 2 compares
  the current config digest with the digest the installation last published (the lineage tail,
  or `installedSha256` before the first publication). On a match it restores the **exact
  original bytes**; on a mismatch it removes **only** the two scoped entries and leaves every
  foreign byte in place. Format 1 keeps refusing to roll back a modified config, because
  restoring the original bytes would destroy the user's later edits.
* **R4 — the lineage is append-only and owned.** Each publication appends one entry with the
  resulting config digest, the generation digest and the authorisation id. A lineage entry that
  does not match the current config means the config changed outside the contract, and the
  reader says so instead of guessing.
* **R5 — a scoped entry that does not match is a refusal.** An ambiguous or missing
  registration is `provider_scope_mismatch`, never a best-effort repair.
* **R6 — no consumer loses a guarantee.** Each consumer that needs a strict pin now takes it on
  the digest it observed itself: the upgrade pins `plan.configDigest` (the bytes it read), the
  model-check pins `plan.configSha256` (the bytes it inspected), and the managed swap already
  carried its own `configSha`. None of them depends on the manifest's whole-file pin any more.

## 5. The authorisation receipt

The contract needs an artefact that says "this human approved *this* generation, from
*this* snapshot". The existing attestation module deliberately cannot express that today
(`src/human-draft-attestation.mjs:30`, `REVIEW_ATTESTED_ONLY`).

The contract introduces a **separate artefact**, not a change to that module's semantics
today:

* a fresh challenge, TTL ≤ 120 s, bound to the pinned snapshot (config digest, scoped-entry
  digests, active generation, candidate generation);
* the human's explicit assertions (every composer reviewed, drafts saved or discarded);
* the process-idle proof;
* **single use** — a receipt cannot be replayed for a second publication;
* output: `{ status: 'ACTIVATION_AUTHORISED', authorisationId, expiresAt, snapshot }`.

The receipt authorises **a transition**; it never performs one, and it never sets
`activationAuthorized`. The transition additionally requires `promotionAllowed === true`,
which stays `false` until a human authorises the transition itself (ADR-0003, decision step
4). A receipt therefore cannot activate anything on its own.

**P3 is implemented and proven** (2026-10-30). `src/promotion-authorisation.mjs` owns the
receipt, as a module of its own: `human-draft-attestation.mjs` keeps its `REVIEW_ATTESTED_ONLY`
semantics untouched, so review evidence and authorisation remain two distinct artefacts.

The trust boundary is the **authorisation directory**, a reserved path owned by the provider:

| artefact | file | guarantee |
| --- | --- | --- |
| the minted challenge | `<challengeId>.challenge.json` | only the process owning the directory can mint a challenge; a hand-made one is `authorisation_challenge_unknown` |
| the one-receipt claim | `<challengeId>.issued` | at most one receipt per challenge, even under a concurrent race |
| the receipt | `<authorisationId>.receipt.json` | its recorded bytes are compared byte for byte, so an edited receipt is `authorisation_receipt_tampered` |
| the one-publication claim | `<authorisationId>.consumed` | at most one publication per receipt, even under a concurrent race |

Every claim is made with an **exclusive create** (`O_EXCL`), so the single-use property is
durable and race-free rather than a convention. A receipt whose snapshot moved is also voided,
so it can never be used later. The receipt is not a signature: its authenticity comes from the
recorded bytes in that directory, and the outer `promotionAllowed` gate still refuses every
transition until a human authorises it separately.

Its suite (`test/promotion-authorisation.test.mjs`, 11 tests) proves the four refusals the
contract names — an expired challenge, a live process, a moved snapshot, a reused receipt — plus
a missing human review, a hand-made challenge, a tampered receipt, an expired receipt, and the
invariant that the receipt authorises without performing anything.

## 6. The preflight transition, and the human-authorisation point

The preflight stops refusing by construction and instead refuses by **evidence**:

1. reconcile every journal (upgrade, managed swap, chained swap, pointer lock);
2. prove the process census is zero, or refuse;
3. verify the payload, the scoped entries and the manifest format;
4. evaluate the durable-draft question — narrowed to the bytes the promotion actually
   touches, which are two scoped entries in `opencode.jsonc`, never the Desktop's composer
   state (B5);
5. issue the challenge;
6. **the human-authorisation point**: the explicit human action that consumes the challenge
   and produces the receipt.

Without step 6, the result stays `NO_GO`. The current unconditional
`unsent_gui_drafts_not_proven_durable` is replaced by the evaluated result of step 4 — and
only if step 4 can actually establish the property it claims. If it cannot, the reason
remains, but it is now a *measured* reason rather than a construction.

## 7. Recovery

| Crash point | State on disk | Classification | Action |
| --- | --- | --- | --- |
| before the lock | nothing | `NOT_STARTED` | re-run |
| after the lock | lock file | `LOCK_HELD` | abandoned-lock recovery, after re-proving the snapshot |
| after staging, before publication | candidate directory, no config change | `STAGED` | re-publish or discard |
| after the rename, before the receipt | new complete config bytes | `PUBLISHED_UNRECORDED` | classify old-or-new by digest, then record or revert |
| after the receipt | new complete config bytes + lineage entry | `PUBLISHED` | normal state |

Every classification is read-only, and none of them ever repairs by rewriting the user's
config.

## 8. Parity with the reference product

The reference product is the same repository's `src/main/` (Chat on Steroids). Its real
guarantees, and the provider's equivalent:

| Reference product | Provider equivalent |
| --- | --- |
| per-call permission checks (`src/main/mcp/kernel.ts:1588-1600`) | OpenCode's own permission policy; the gateway never executes a tool (ADR-0002) |
| atomic durable writes (`src/main/durable.ts:195`, `src/main/config.ts:882-892`) | the durable journal + single-rename publication above |
| staged update with digest verification (`src/main/update.ts:562-619`) | the staged candidate + digest-addressed publication (`src/official-upgrade.mjs:240-276`) |
| install rollback (`src/main/plugins/manager.ts:439`) | the scoped rollback of format 2 (R3) |
| restart/quit handover (`src/main/update.ts:557-560`) | `RESTART_REQUIRED_ONLY` |

What the reference product does **not** have, and therefore is not a parity requirement:
an attestation module, a CI gate that forbids authorisation, or a preflight that refuses by
construction. Those are harness staging policy, and this contract deliberately does not
reproduce them as product invariants.

## 9. Implementation plan

Each step is RED → GREEN, on this machine, with no personal profile involved.

| Step | Deliverable | Proof it requires |
| --- | --- | --- |
| **P1** | generalise the CAS owner to scoped edits | a competing edit at `before_publish` leaves the competitor's bytes intact and raises `native_cas_changed`; a scoped option edit preserves every foreign byte; an ambiguous reference refuses |
| **P2** | format-2 manifest and upgrade-aware reader | after a publication, the install still verifies; a foreign edit made in between survives an entry-scoped rollback; an unknown format fails closed |
| **P3** | the authorisation receipt | an expired challenge, a reused receipt, a moved snapshot and a live process each refuse. **Implemented and proven** (§5, 11 tests) |
| **P4** | the transition and its `bin/` entry point | the command exists and refuses with `promotionAllowed === false`; the refusal is machine-readable and changes nothing on disk |
| **P5** | the preflight transition path | every pre-existing NO_GO case still returns NO_GO; the new NO_GO cases are evidence-based, not constructed. **Blocked by P6** (below) |
| **P6** | the durable-draft contract | the promotion's touched-byte set is proven to exclude the Desktop's composer state. **Blocked: not established** (below) |

**P5 and P6 status (2026-10-30): blocked, NO-GO.** The preflight still refuses with
`unsent_gui_drafts_not_proven_durable`, and its suite (`test/activation-preflight.test.mjs`, 5 tests)
passes unchanged. The touched-byte set of a promotion is measurable: `opencode.jsonc` (two scoped
entries), the format-2 manifest and the provider's own generation directories. Excluding the
Desktop's composer state from that set, though, requires locating where the Desktop stores
unsent composers and proving that a promotion never reads or writes there. That location has not
been measured. Inspecting the Desktop's personal state to find it is outside the scope this
contract allows, so the property cannot be established. Under §6 the draft reason therefore
stays, and the result stays `NO_GO`. Removing the reason on a declared allowlist alone would be
the construction this contract forbids.

**P1 is implemented and proven** (2026-10-30). `publishScopedConfigEdits`
(`src/official-versioned-pointer.mjs`) publishes scoped edits under the same lock, the same
quiescence census, the same CAS pin and the same native rename as the pointer publication,
which is now a thin caller of the shared owner. Its suite
(`test/official-versioned-pointer-scoped-edits.test.mjs`) proves that a scoped option edit
preserves every foreign byte and is byte-exactly reversible, that a competing edit at
`before_publish` leaves the competitor's bytes intact, and that a moved config, an
overlapping edit, an edit that would break the JSONC, an invalid UTF-8 config, a config
starting with a BOM (its offsets would otherwise depend on the caller's decoder) and a
pending managed transition are each refused before a byte is written.

**P2 is implemented and proven** (2026-10-30). The install manifest is now written in format 2:
`src/official-scoped-config.mjs` owns the scope model, and `src/official-install.mjs` writes the
manifest, reads it and rolls back with it. The scope identifies the owned plugin registration by
two independent stable conditions — our own option keys in its `options` object, and a `package`
pointing at a direct `.chat-on-opencode-*` child of the config directory — so the manifest pins
no path that a publication would rewrite. Its suite (`test/official-install-format2.test.mjs`, 7
tests) proves that the install still verifies after a scoped publication, that a **pointer-style
repoint to a digest-addressed `.chat-on-opencode-version-<sha>` generation keeps the install
verifiable** (the production path, and the reason the scope is a namespace rather than a path),
that a foreign edit made in between survives an entry-scoped rollback byte for byte while the
two owned entries are removed, that an untouched install still restores the exact original bytes,
that a format-1 manifest keeps its strict whole-file pin, that an unknown format fails closed
(`provider_manifest_shape_unknown`), and that a repointed, removed or duplicated owned entry is
refused (`provider_scope_mismatch`) rather than repaired. The lineage (R4) is the discriminator:
the expected config digest is the lineage tail, or `installedSha256` before the first
publication; a match restores the exact original bytes (`EXACT_RESTORE`), a mismatch removes
only the owned entries (`SCOPED_REMOVAL`).

No consumer lost a guarantee (R6): the upgrade now pins `plan.configDigest`, the model-check
pins `plan.configSha256` and refuses a stale plan with `official_model_config_changed_since_plan`,
and the doctor reports `backupHashVerified`, `configOwnershipVerified` and `configDrift` instead
of one whole-file verdict. The managed swap propagates format 2 unchanged, because it copies the
manifest as it is.

P1 and P2 are the two that unblock everything else. Neither touches a lock, a flag or a
personal profile, and neither can promote anything: the transition in P4 refuses until
`promotionAllowed` is `true`, which stays `false`.

## 10. What this document does not do

* It does not authorise a promotion, an activation or a personal installation.
* It does not change `promotionAllowed` or `activationAuthorized`, which stay `false`.
* It does not lift any of the four locks in ADR-0003. B5 and B6 describe how a future
  preflight *could* be evidence-based; the locks stay until a human decides otherwise.
* It does not change the reference product's parity target, and it does not weaken the
  existing refusals.
