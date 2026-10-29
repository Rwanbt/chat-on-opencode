// How the offline CoS fixture recognises the bridge's read protocol.
//
// The fixture stands in for ChatGPT: it answers with the read envelope when
// the prompt states the read contract, and it answers the tool result when
// the prompt carries the result. It must key on the *protocol* - the markers
// the bridge actually sends - and never on a sentence of the instructions,
// whose wording is free to change (ADR-0006, ADR-0008). Keying on a sentence
// is how the fixture silently stopped firing once, and the hosted native-read
// E2E failed on a cause that had nothing to do with the read path.
//
// The markers come from the product, so there is one authority for them; the
// drift guard in `test/read-protocol.test.mjs` asserts that the shipped
// prompts still carry them.
import { READ_PROTOCOL_MARKER, READ_RESULT_MARKER } from '../../src/native-read.mjs'

/**
 * Which read turn a text is.
 *
 * - `intent`: the bridge states the read protocol and asks for the envelope;
 * - `result`: the bridge carries the native tool's output back to the model;
 * - `none`: anything else, including a plain text turn.
 */
export function readTurnKind(text) {
  if (typeof text !== 'string') return 'none'
  if (text.includes(READ_RESULT_MARKER)) return 'result'
  if (text.includes(READ_PROTOCOL_MARKER)) return 'intent'
  return 'none'
}
