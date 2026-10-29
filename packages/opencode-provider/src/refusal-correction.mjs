// A refusal is not an answer.
//
// The protocol tells the model that it has no access of its own and that the
// tools listed in the manifest are its access, so an answer that says the
// machine is unreachable contradicts the protocol instead of satisfying it.
// ChatGPT injects the status of its own connector into the model view, and a
// model that reads that status as a blocker refuses the task in prose.
//
// The bridge therefore recognises a refusal-shaped answer and asks once more,
// with a corrective message that repeats the protocol and its worked example.
// The correction is bounded (one per native turn), deterministic (the same
// message id every time, so a crash cannot duplicate it) and never
// fabricated: if the second answer is prose too, that prose is returned.

/**
 * The refusal shapes this bridge acts on.
 *
 * Only strong markers are listed. A weak marker such as the word "connection"
 * appears in legitimate final answers ("the connection test passes") and would
 * push the model to act after the task is already done.
 *
 * The boundaries are Unicode-aware lookarounds: `\b` is defined on ASCII word
 * characters only, so it never matches after an accented letter such as the
 * "é" of "échoué".
 */
const REFUSAL_MARKERS = [
  'impossible',
  "n['’]ai pas pu",
  'je ne peux pas',
  "je n['’]ai pas pu",
  'a échoué',
  'failed to',
  'unable to',
  'cannot',
  "can['’]t",
  "couldn['’]t",
  'not connected',
  'tunnel-client',
].map(source => new RegExp('(?<![\\p{L}\\p{N}_])' + source + '(?![\\p{L}\\p{N}_])', 'iu'))

/** True when the answer says the task could not be carried out. */
export function looksLikeRefusal(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  return REFUSAL_MARKERS.some(marker => marker.test(text))
}

/**
 * The corrective message.
 *
 * It repeats the only two things the model needs: the task is carried out by
 * requesting a tool, and this is what a request looks like. It never accuses
 * the model, never asks for an apology and never mentions the connector, so
 * the correction cannot be mistaken for a new task.
 */
export function refusalCorrection({ location = null } = {}) {
  const example = '<opencode-tool>' + JSON.stringify({
    name: 'read', arguments: { path: location ?? 'ABSOLUTE_FILE_PATH' },
  }) + '</opencode-tool>'
  return [
    'That was a refusal, not an answer. This task is carried out by requesting tools.',
    'Answer now with exactly one envelope and nothing else, for example:',
    example,
    'Do not explain, do not apologise, and do not mention any connection, tunnel or connector state.',
  ].join('\n')
}
