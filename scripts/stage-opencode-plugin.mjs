import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(repository, 'packages', 'opencode-provider')
const files = ['package.json', 'README.md', 'OFFICIAL_INSTALL.md', 'opencode.example.jsonc']
const folders = ['bin', 'plugin', 'src']

function safeDirectory(directory) {
  if (!existsSync(directory)) mkdirSync(directory)
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('standalone_plugin_destination_not_regular_directory')
  }
}

/** Stage the installable plugin beside the provider binary, never in a personal profile. */
export function stageStandaloneProvider(destination = path.join(repository, 'release', 'provider', 'opencode-plugin')) {
  if (!path.isAbsolute(destination)) throw new Error('standalone_plugin_absolute_destination_required')
  const release = path.join(repository, 'release')
  const parent = path.join(release, 'provider')
  // The build owns this tree. Replacing any external path or an alias would violate isolation.
  if (path.resolve(destination) !== path.join(parent, 'opencode-plugin')) {
    throw new Error('standalone_plugin_destination_outside_build_tree')
  }
  safeDirectory(release)
  safeDirectory(parent)
  safeDirectory(destination)
  // Reject symlinks, irregular files and stale entries at *every* depth.
  // Addons nested under src/ must be staged, not accidentally omitted.
  function stageTree(relative = '') {
    const inputDir = path.join(source, relative)
    const outputDir = path.join(destination, relative)
    safeDirectory(outputDir)
    const entries = readdirSync(inputDir)
    const names = new Set(entries)
    for (const name of readdirSync(outputDir)) {
      if (!names.has(name)) throw new Error('standalone_plugin_unexpected_existing_file')
    }
    for (const name of entries) {
      const relativeEntry = path.join(relative, name)
      const input = path.join(source, relativeEntry)
      const output = path.join(destination, relativeEntry)
      const info = lstatSync(input)
      if (info.isSymbolicLink()) throw new Error('standalone_plugin_unsafe_file_type')
      if (info.isDirectory()) {
        if (existsSync(output) && !lstatSync(output).isDirectory()) {
          throw new Error('standalone_plugin_unsafe_file_type')
        }
        stageTree(relativeEntry)
      } else if (info.isFile()) {
        if (existsSync(output) && (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink())) {
          throw new Error('standalone_plugin_unsafe_file_type')
        }
        copyFileSync(input, output)
      } else throw new Error('standalone_plugin_unsafe_file_type')
    }
  }
  const rootExpected = new Set([...files, ...folders])
  for (const name of readdirSync(destination)) {
    if (!rootExpected.has(name)) throw new Error('standalone_plugin_unexpected_existing_file')
  }
  for (const file of files) {
    const input = path.join(source, file)
    const output = path.join(destination, file)
    if (!lstatSync(input).isFile() || lstatSync(input).isSymbolicLink() ||
      (existsSync(output) && (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink()))) {
      throw new Error('standalone_plugin_unsafe_file_type')
    }
    copyFileSync(input, output)
  }
  for (const folder of folders) stageTree(folder)
  const pkg = JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'))
  if (pkg.name !== 'chat-on-opencode-provider' || !pkg.bin?.['chat-on-opencode-config']) {
    throw new Error('standalone_plugin_package_manifest_invalid')
  }
  return destination
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('Staged standalone OpenCode plugin: ' + stageStandaloneProvider() + '\n')
}
