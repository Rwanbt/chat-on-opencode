# ADR-0010: ChatGPT's citation directive is product metadata, not an answer

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0002 (the bridge), ADR-0004 (evidence scope), ADR-0009 (what ends a turn)

## Context

The first complete live run of the coding loop (read → patch → shell → answer, against the real
ChatGPT account) exposed a failure that the run itself hid. The journal of that turn holds, in
this order:

| seq | Row |
| --- | --- |
| 18 | `assistant_message` — `::chatgpt-content-reference{index="0" source_message_id="cb3b21bb-…"}` |
| 19 | the same directive again |
| 20 | `assistant_message` — the model's `patch` envelope |

The first two rows are **not** the model's answer. They are ChatGPT's own inline citation
directive, which names another message of the conversation. The CoS recorder publishes such a row
as an `assistant_message` of the turn, exactly as the model's own text, and the recorder's own
renderer already knows the shape (`src/renderer/chat.ts`: `INLINE_REFERENCE`).

The bridge held the directive as the answer. The model's real answer that followed it did not
extend it, so the bridge refused the turn with `cos_answer_revision_not_streamable`. The run
recovered because OpenCode's retry policy re-sent the turn, and the retry read a journal in which
the recorder had already replaced the superseded rows with the final one. The retry hid the
defect; it did not remove it.

Two rules of this repository are at stake:

- **No blind retry.** A failure that only disappears on the second attempt is a defect, not a
  flake.
- **A revision must extend the previous text.** That rule protects a streamed answer from
  contradicting itself. It is only sound when every row it is applied to is the model's text.

## Decision

**A row that carries only ChatGPT's inline citation directive is not an answer.** The bridge
recognises the directive (`::{1,2}chatgpt-content-reference{…}`, the whole row) and ignores it: it
is neither held as the answer, nor streamed to the user, nor compared against the previous text.
The model's answer that follows is the answer of the turn.

**A directive that trails a real answer stays part of that answer.** CoS's renderer treats it as an
inline citation at the end of a reply. The row is then the model's text, it is kept whole, and the
revision rule applies to it as before.

The rule is narrow on purpose: it recognises one product directive, in one shape, and only when
the row carries nothing else. It does not strip text from an answer and does not weaken the
revision rule for anything else.

## Consequences

- The live failure is removed at its cause: the turn that carried a citation directive and then
  the answer now succeeds on the first attempt.
- The revision rule keeps its force for every row that is actually the model's text.
- A turn whose only assistant row is a directive ends with no answer — as it did before, and as
  it should: the model said nothing.
- The bridge depends on one ChatGPT product artefact by name. When ChatGPT changes the shape, the
  rule stops matching and the old behaviour returns visibly (a refused turn), not silently.

## Alternatives considered

- **Strip every directive-shaped substring from an answer.** Rejected: it would rewrite the
  model's text, and the citation is part of what the user should see in a plain-text answer.
- **Accept any revision that does not extend the previous text.** Rejected: it removes the only
  protection against a recorder that contradicts itself, and it would let a stale row replace a
  fresh answer.
- **Treat the directive as the answer and wait for the next row to replace it.** Rejected: that is
  the behaviour that failed, and it makes the failure depend on the retry.
- **Fix it in the CoS recorder.** Rejected here: the recorder is the product's own transcript
  store, it keeps what ChatGPT produced, and this provider must not change what the account's
  transcript says.

## Evidence

- `src/assistant-row.mjs` — `isContentReferenceMarker`.
- `src/gateway.mjs` — the assistant row branch ignores a directive-only row and records
  `assistant_marker_ignored` as evidence.
- `test/assistant-row.test.mjs` — the directive, the answer that trails it, and the ordinary
  answers.
- `test/native-tools.test.mjs` — *ChatGPT's citation directive is not an answer, and the answer
  after it still is*: the coding envelope that follows the directive becomes the tool call.
- Live proof: the isolated CoS profile's journal for the 22:18 run (rows 18/19 = the directive,
  row 20 = the envelope).

**Evidence level.** The directive and its position in the answer stream are *authentic* (a live
run against the real ChatGPT account). The regression tests are *synthetic* and reproduce the same
row order deterministically.

## Revisit trigger

Revisit when ChatGPT changes the shape of its inline citation directive, when the CoS recorder
stops publishing product directives as assistant rows, or when the bridge gains a transport that
delivers the model's answer without the product layer's rows.
