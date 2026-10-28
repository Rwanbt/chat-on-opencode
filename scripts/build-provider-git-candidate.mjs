/**
 * CI-only canonical Git candidate builder. No installation, pointer publication,
 * account access, promotion, or power-loss guarantee.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = data => createHash('sha256').update(data).digest('hex')
const allowed = /^packages\/opencode-provider\/(?:bin\/|plugin\/|src\/|README\.md$|package\.json$|opencode\.example\.jsonc$)/
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding:'buffer', maxBuffer:10_000_000 })
const gitText = (repo, args) => git(repo, args).toString('utf8').trim()

export function stageGitCandidate(repo, sourceCommit, destination) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !path.isAbsolute(destination) ||
      existsSync(destination) || existsSync(destination + '.manifest.json')) {
    throw Error('candidate_invalid_source_or_existing_destination')
  }
  if (gitText(repo, ['rev-parse', sourceCommit + '^{commit}']) !== sourceCommit) throw Error('candidate_commit_not_canonical')
  const files = git(repo, ['ls-tree', '-rz', '--name-only', sourceCommit, '--', 'packages/opencode-provider/'])
    .toString('utf8').split('\0').filter(name => allowed.test(name))
  if (!files.includes('packages/opencode-provider/plugin/index.ts') ||
      !files.includes('packages/opencode-provider/src/server.mjs')) throw Error('candidate_required_provider_files_missing')
  const parent = path.dirname(destination)
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) throw Error('candidate_parent_missing')
  const staging = path.join(parent, '.' + path.basename(destination) + '-' + randomUUID() + '.stage')
  mkdirSync(staging)
  const entries = []
  for (const name of files.sort()) {
    const record = gitText(repo, ['ls-tree', sourceCommit, '--', name])
    if (!/^100644 blob [a-f0-9]{40}\t/.test(record)) throw Error('candidate_symlink_or_executable_refused')
    const relative = name.slice('packages/opencode-provider/'.length)
    const bytes = git(repo, ['show', sourceCommit + ':' + name])
    const target = path.join(staging, relative)
    mkdirSync(path.dirname(target), { recursive:true })
    writeFileSync(target, bytes, { flag:'wx', mode:0o600 })
    entries.push({ path:relative, gitBlob:record.match(/blob ([a-f0-9]{40})/)[1],
      sha256:sha(bytes), bytes:bytes.length })
  }
  function digest(directory) {
    const hash = createHash('sha256')
    function walk(dir, prefix='') {
      for (const name of readdirSync(dir).sort()) {
        const location = path.join(dir,name), relative = prefix+name, st = lstatSync(location)
        if (st.isSymbolicLink()) throw Error('candidate_symlink_refused')
        if (st.isDirectory()) { hash.update('dir:'+relative+'\0'); walk(location,relative+'/') }
        else if (st.isFile()) { hash.update('file:'+relative+'\0'); hash.update(sha(readFileSync(location))) }
        else throw Error('candidate_unsafe_file')
      }
    }
    walk(directory)
    return hash.digest('hex')
  }
  const candidateDigest = digest(staging)
  renameSync(staging, destination)
  const manifest = { version:1, sourceCommit, fileCount:entries.length, candidateDigest, entries,
    activationAuthorized:false, promotionAllowed:false }
  const manifestPath = destination + '.manifest.json'
  writeFileSync(manifestPath, JSON.stringify(manifest,null,2)+'\n', { flag:'wx', mode:0o600 })
  return { candidateDigest, manifestSha256:sha(readFileSync(manifestPath)), fileCount:entries.length,
    activationAuthorized:false, promotionAllowed:false }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = stageGitCandidate(process.cwd(), process.argv[2], process.argv[3])
  process.stdout.write(JSON.stringify(result)+'\n')
}
