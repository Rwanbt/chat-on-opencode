import assert from 'node:assert/strict'
import test from 'node:test'
import { looksLikeRefusal, refusalCorrection } from '../src/refusal-correction.mjs'

test('a refusal-shaped answer is recognised', () => {
  // The three refusals observed in live runs against the real account.
  for (const text of [
    "Je n'ai pas pu modifier `sum.js` ni exécuter le test, car la connexion à l'environnement Windows a échoué.",
    'Impossible de modifier `sum.js` et de vérifier le test : la connexion locale Chat On Steroids est interrompue (`Tunnel-client not seen for 300 seconds`).',
    "Le correctif est `return a + b`, mais l'accès au projet a échoué : le fichier n'a pas été modifié.",
    'I cannot run the test, the environment is unreachable.',
    "I couldn't modify the file.",
    'The tunnel-client is not connected.',
  ]) assert.equal(looksLikeRefusal(text), true, text)
})

test('an ordinary answer is not a refusal', () => {
  for (const text of [
    'Le test passe.',
    'The sum function now adds its arguments and the test passes.',
    'Voici ce que fait le fichier.',
    '',
    '   ',
  ]) assert.equal(looksLikeRefusal(text), false, JSON.stringify(text))
  assert.equal(looksLikeRefusal(null), false)
  assert.equal(looksLikeRefusal(undefined), false)
  assert.equal(looksLikeRefusal(42), false)
})

test('the correction repeats the protocol with a worked example and no accusation', () => {
  const text = refusalCorrection({ location: 'C:\\project' })
  assert.match(text, /refusal, not an answer/)
  assert.match(text, /<opencode-tool>\{"name":"read","arguments":\{"path":"C:\\\\project"\}\}<\/opencode-tool>/)
  assert.doesNotMatch(text, /\b(sorry|I apologise|we apologise)\b/i)
  assert.doesNotMatch(text, /you failed/i)
})

test('the correction stays bounded when no project directory is known', () => {
  const text = refusalCorrection({})
  assert.match(text, /ABSOLUTE_FILE_PATH/)
  assert.ok(text.length < 1000)
})
