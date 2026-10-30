import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stageGitCandidate } from '../scripts/build-provider-git-candidate.mjs'
import { candidateDigest } from '../packages/opencode-provider/src/official-upgrade.mjs'

test('canonical Git blob candidate stages exact immutable files and refuses overwrite', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-canonical-candidate-'))
  t.after(() => rmSync(root, { recursive:true, force:true }))
  const repo = path.join(root, 'git')
  mkdirSync(repo)
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding:'utf8' }).trim()
  git(['init', '-q'])
  git(['config', 'user.name', 'test-owned'])
  git(['config', 'user.email', 'test@example.invalid'])
  for (const dir of ['plugin','src']) mkdirSync(path.join(repo,'packages','opencode-provider',dir), { recursive:true })
  const plugin = path.join(repo,'packages','opencode-provider','plugin','index.ts')
  const server = path.join(repo,'packages','opencode-provider','src','server.mjs')
  writeFileSync(plugin, 'export default {}\n')
  writeFileSync(server, 'export const placeholder = true\n')
  git(['add','.'])
  git(['commit','-qm','test fixture'])
  const source = git(['rev-parse','HEAD'])
  const output = path.join(root, 'candidate-Z-throwaway')
  const result = stageGitCandidate(repo, source, output)
  assert.equal(result.activationAuthorized, false)
  assert.equal(result.promotionAllowed, false)
  assert.equal(result.fileCount, 2)
  assert.equal(candidateDigest(output), result.candidateDigest)
  assert.equal(readFileSync(path.join(output,'plugin','index.ts'),'utf8'), 'export default {}\n')
  const manifest = JSON.parse(readFileSync(output+'.manifest.json','utf8'))
  assert.equal(manifest.sourceCommit, source)
  assert.deepEqual(manifest.entries.map(e => e.path), ['plugin/index.ts','src/server.mjs'])
  assert.ok(manifest.entries.every(e => /^[a-f0-9]{40}$/.test(e.gitBlob) && /^[a-f0-9]{64}$/.test(e.sha256)))
  assert.equal(createHash('sha256').update(readFileSync(output+'.manifest.json')).digest('hex'), result.manifestSha256)
  assert.throws(() => stageGitCandidate(repo, source, output), /candidate_invalid_source_or_existing_destination/)
  assert.throws(() => stageGitCandidate(repo, '0'.repeat(40), path.join(root,'unknown')), /candidate_commit_not_canonical|git/)
  assert.equal(existsSync(path.join(root,'unknown')), false)
})
