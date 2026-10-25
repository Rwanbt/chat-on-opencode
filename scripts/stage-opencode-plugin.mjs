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
  const expected = new Map([['', new Set([...files, ...folders])]])
  for (const folder of folders) {
    safeDirectory(path.join(destination, folder))
    expected.set(folder, new Set(readdirSync(path.join(source, folder))))
  }
  for (const [folder, names] of expected) {
    for (const name of readdirSync(path.join(destination, folder))) {
      if (!names.has(name)) throw new Error('standalone_plugin_unexpected_existing_file')
    }
  }
  for (const file of [...files, ...folders.flatMap(folder => [...expected.get(folder)].map(name => path.join(folder, name)))]) {
    const input = path.join(source, file)
    const output = path.join(destination, file)
    if (!lstatSync(input).isFile() || (existsSync(output) && !lstatSync(output).isFile())) {
      throw new Error('standalone_plugin_unsafe_file_type')
    }
    copyFileSync(input, output)
  }
  const pkg = JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'))
  if (pkg.name !== 'chat-on-opencode-provider' || !pkg.bin?.['chat-on-opencode-config']) {
    throw new Error('standalone_plugin_package_manifest_invalid')
  }
  return destination
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('Staged standalone OpenCode plugin: ' + stageStandaloneProvider() + '\n')
}
