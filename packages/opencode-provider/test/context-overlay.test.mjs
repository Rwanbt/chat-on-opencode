import assert from 'node:assert/strict'
import { test } from 'node:test'
import { raiseLegacyCoSContext } from '../src/context-overlay/overlay.mjs'

function fixture(context = 16_384, output = 2_048, provider = 'chat-on-opencode', id = 'chatgpt-default') {
  const target = { providerID: provider, id, limit: { context, output } }
  const other = { providerID: 'anthropic', id: 'test', limit: { context: 16_384, output: 2_048 } }
  const modified = []
  const editor = {
    get(p, m) { return target.providerID === p && target.id === m ? target : undefined },
    update(p, m, apply) {
      assert.equal(p, 'chat-on-opencode')
      assert.equal(m, 'chatgpt-default')
      modified.push(p + '/' + m)
      apply(target)
    },
  }
  return { editor, target, other, modified }
}

test('only legacy CoS model gets expanded above OpenCode V2 compaction reserve', () => {
  const f = fixture()
  assert.equal(raiseLegacyCoSContext(f.editor), true)
  assert.equal(f.target.limit.context, 65_536)
  assert.equal(f.target.limit.output, 2_048)
  assert.deepEqual(f.modified, ['chat-on-opencode/chatgpt-default'])
  assert.equal(f.other.limit.context, 16_384)
  assert.equal(raiseLegacyCoSContext(f.editor), false)
  assert.deepEqual(f.modified, ['chat-on-opencode/chatgpt-default'])
})

test('model overlays fail closed on other identities or changed source limits', () => {
  for (const opts of [
    [65_536, 2_048, 'chat-on-opencode', 'chatgpt-default'],
    [16_384, 4_096, 'chat-on-opencode', 'chatgpt-default'],
    [16_384, 2_048, 'anthropic', 'chatgpt-default'],
    [16_384, 2_048, 'chat-on-opencode', 'other'],
  ]) {
    const f = fixture(...opts)
    assert.equal(raiseLegacyCoSContext(f.editor), false)
    assert.equal(f.target.limit.context, opts[0])
    assert.deepEqual(f.modified, [])
  }
})
