# ADR-0009: A completed turn is not finished until its final assistant row has been read

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** provider maintainer
- **Relates to:** ADR-0002 (the bridge), ADR-0004 (evidence scope), ADR-0008 (protocol and chain)

## Context

Two live runs against the real ChatGPT account ended with **no answer at all**, while the model
had in fact answered:

| Run | What the journal shows | What the native caller saw |
| --- | --- | --- |
| 21:01 | `assistant_message` (seq 14) carrying a valid `patch` envelope, stored with `state: final` | one `step_start`, no answer |
| 21:23 | `turn_end` (seq 6, `completed`), no assistant row before it | one `step_start`, no answer |

The stored message proves the ordering. For the 21:01 turn:

| Fact | Value |
| --- | --- |
| `turn_end` observed at | `1793304110779` |
| assistant message first observed at | `1793304108869` |
| assistant message **finalised** at (`finalObservedAt`) | `1793304110782` |

The answer became final **3 ms after** the turn ended. The gateway read the journal in sequence
order and stopped at `turn_end` (seq 10); the assistant row (seq 14) was already in the same
batch, behind the terminal event, and was never read. The turn therefore completed with an empty
answer — and, in coding mode, an empty answer is not a tool call.

This is not an upstream defect and not a race to retry: CoS documents the behaviour in its own
source (`src/main/bridge.ts`):

> content.js closes a generation synchronously, but its final Fiber refresh crosses a MAIN-world
> async hop. `turn_end` can therefore reach one `/events` batch and the matching final assistant
> row the next.

The bridge was reading that stream as if `turn_end` closed the answer. It does not: it closes the
*turn*, and the answer is the assistant row that follows.

## Decision

**A completed turn with no answer yet is not finished.** When the gateway observes a `turn_end`
whose outcome is `completed` and it holds **no assistant text at all**, it keeps reading the event
stream for a **bounded** grace window (3 s) instead of concluding the turn with an empty answer.
The first assistant row of that turn — final or not — ends the wait; a final row
(`final === true` or `state === 'final'`) closes the turn immediately.

**A turn that already holds an answer closes on `turn_end`, as before.** The grace exists for the
one state that was broken (a completed turn with nothing in hand). It is not a general wait, it
does not slow the ordinary turn down, and it never fabricates an answer: when the grace expires
with no row, the turn ends exactly as it did before.

**Foreign events after a completed turn are not supersessions.** Once the turn is complete, a new
user message or a new turn in the same ChatGPT conversation (the user typing while the bridge
waits) cannot supersede a turn that is already proven complete. Those events are ignored while the
grace runs; before the turn end they still fail closed with `cos_input_superseded` and
`cos_turn_superseded`, as before.

**Our own rows are recognised by identity, not by position.** The recorder can re-publish a
revised row with a newer sequence number (the 21:01 user message moved from seq 3 to seq 15). The
gateway therefore remembers the input ids it owns — the admitted input and the refusal correction —
and recognises its own `user_message` rows wherever they appear, instead of treating a re-published
own row as a foreign message that supersedes the turn.

## Consequences

- A completed turn with no answer in hand waits at most 3 s and then ends with what is proven. The
  two live failures (empty answer, lost `patch` envelope) cannot happen again in that form.
- The turn still fails closed when nothing is proven: an unconfirmed turn (`cos_turn_unconfirmed`),
  an incomplete answer (`cos_output_incomplete`) and a revision that does not extend the previous
  text (`cos_answer_revision_not_streamable`) are unchanged.
- The grace costs nothing on the ordinary path: a turn that already holds text closes on
  `turn_end`.
- The bridge now depends on the *publication* order of the journal rather than on the assumption
  that the terminal event carries the answer. The CoS stream already guarantees that a row is
  re-published with a newer sequence when the recorder revises it, so the final row is always
  reachable within the grace.

## Alternatives considered

- **Re-open the session and re-read the journal when the answer is empty.** Rejected: the stream
  is already the journal's publication feed, and the answer is in the batch behind the terminal
  event. A second read would be a retry of a read that already succeeded.
- **Wait for the final row on every turn.** Rejected: it would add the grace to every turn and
  would keep the upstream stream open after a turn that is already proven complete.
- **Treat an empty answer as a failure (fail closed with an error).** Rejected for now: an empty
  answer is a legitimate outcome of a turn that produced no text, and changing it would alter the
  plain-text contract. The grace removes the *cause* of the empty answers we observed.
- **Ask the model again when the answer is empty.** Rejected: the refusal correction exists for a
  refusal; an empty turn is not a refusal, and asking again would send a second input for a turn
  that already has its answer in the journal.

## Evidence

- `src/gateway.mjs` — `nextEventWithin` (the bounded read), the `finalSeen` / `graceDeadline` pair,
  the `ownInputIDs` identity check, and the grace rule itself.
- `test/bridge.test.mjs` — *a completed turn whose final answer arrives after turn_end is still
  answered*: the plain-text answer and its single emission.
- `test/native-tools.test.mjs` — *the envelope that arrives after the turn end is still the answer
  of that turn*: the coding envelope becomes the tool call.
- Live proof: the isolated CoS profile's session journal
  (`sessions/fc95be51-…/messages/b1184aa5….json`: `final: true`, `finalObservedAt` 3 ms after
  `turn_end`) and the gateway's own event dump for the same run.

**Evidence level.** The ordering and the lost answer are *authentic* (live runs against the real
ChatGPT account through the isolated CoS profile). The regression tests are *synthetic* and
reproduce the same publication order deterministically.

## Revisit trigger

Revisit when CoS publishes the final assistant row before the terminal event for every turn, when
the recorder stops re-publishing revised rows with newer sequence numbers, or when the bridge
gains a transport that delivers the answer and the terminal event atomically.
