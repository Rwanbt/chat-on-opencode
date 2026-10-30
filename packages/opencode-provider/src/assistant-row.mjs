// What an assistant row of the CoS journal carries, and what it does not.
//
// ChatGPT's product layer injects its own directives into the assistant
// stream. The inline citation directive
// `::chatgpt-content-reference{index="0" source_message_id="…"}` names another
// message of the conversation; the CoS recorder publishes such a row as an
// `assistant_message` of the turn, exactly as the model's own text.
//
// It is product metadata, not an answer. The bridge must not hold it as the
// answer: the model's answer that follows it would then look like a
// contradiction of it, and the turn would fail with
// `cos_answer_revision_not_streamable` — a failure that a retry hides but
// does not remove.
//
// The same shape is already known to CoS's own renderer
// (`src/renderer/chat.ts`: `INLINE_REFERENCE`), which strips the directive
// from a reply before drawing it.

// One directive, and nothing else. A directive that trails a real answer is
// part of that answer and is left alone.
const CONTENT_REFERENCE = /^:{1,2}chatgpt-content-reference\{[^}\n]*\}$/

/** True when the row carries only ChatGPT's inline citation directive. */
export function isContentReferenceMarker(text) {
  return typeof text === 'string' && CONTENT_REFERENCE.test(text.trim())
}
