import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancellationReceiptStage } from '../src/gateway.mjs'

test('Stop receipt explicitly confirmed by broker only', () => {
  assert.equal(cancellationReceiptStage({ stopped:true }), 'cancel_command_acknowledged')
  assert.equal(cancellationReceiptStage({ cancelled:true }), 'cancel_command_acknowledged')
  for (const reply of [undefined, null, {}, {stopped:false}, {stopped:'true'}, {error:'not_current_turn'}, {ok:true}]) {
    assert.equal(cancellationReceiptStage(reply), 'cancel_command_unconfirmed')
  }
})
