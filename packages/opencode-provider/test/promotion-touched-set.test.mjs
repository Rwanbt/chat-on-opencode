import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { touchedSetDisjointFrom } from '../src/promotion-touched-set.mjs'

test('a config root outside the Desktop user data directory is disjoint from it', () => {
  const config = path.join(tmpdir(), 'coo-touched-config')
  const desktop = path.join(tmpdir(), 'coo-touched-desktop')
  const result = touchedSetDisjointFrom(config, desktop)
  assert.equal(result.disjoint, true)
  assert.equal(result.reason, null)
})

test('a config root inside the Desktop user data directory is refused', () => {
  const desktop = path.join(tmpdir(), 'coo-touched-desktop')
  const config = path.join(desktop, 'opencode')
  const result = touchedSetDisjointFrom(config, desktop)
  assert.equal(result.disjoint, false)
  assert.equal(result.reason, 'touched_set_overlaps_desktop_state')
})

test('the Desktop user data directory that holds drafts.sqlite is disjoint from the real config root', () => {
  const desktop = path.join(process.env.APPDATA ?? '', 'ai.opencode.desktop')
  if (!existsSync(path.join(desktop, 'drafts.sqlite'))) return
  const config = path.join(process.env.USERPROFILE ?? '', '.config', 'opencode')
  const result = touchedSetDisjointFrom(config, desktop)
  assert.equal(result.disjoint, true, result.reason)
})
