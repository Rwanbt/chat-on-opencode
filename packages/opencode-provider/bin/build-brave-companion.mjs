#!/usr/bin/env node
// Build a separately installed, provider-targeted Brave companion from the
// reviewed CoS extension release. The login interaction itself remains owned
// by that original extension; this file adds no browser credential handling.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const source = path.join(repository, 'extension')
const output = process.env.CHAT_ON_OPENCODE_COMPANION_BUILD_TEST_DIR ??
  path.join(repository, 'packages', 'opencode-provider', 'dist', 'brave-chat-on-opencode')
const expected = 'const PORTS = [8765, 8766, 8767, 8768, 8769, 18765, 18766, 18767, 18768, 18769, 38765, 38766, 38767, 38768, 38769];'
const sourceWorker = readFileSync(path.join(source, 'background.js'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8'))
// Qualify the exact reviewed extension revision, not merely its version label.
const sourceHash = createHash('sha256').update(sourceWorker).digest('hex')
if (sourceHash !== 'b8371ee722043753475a3608f777d1f68a1c239df125466019258133ece6c392') {
  throw new Error('companion_unreviewed_source')
}
if (!path.isAbsolute(output) || path.resolve(output) === source ||
  path.resolve(output).startsWith(source + path.sep)) throw new Error('companion_unsafe_output')
if (sourceWorker.split(expected).length !== 2 || manifest.version !== '2.1.46' ||
  manifest.background?.service_worker !== 'background.js' ||
  !manifest.host_permissions.includes('http://127.0.0.1:8766/*')) {
  throw new Error('unqualified_companion_source')
}
const assets = [
  'background.js', 'browser-control.js', 'browser-control-page.js',
  'active-tabs.js', 'i18n.js', 'popup.html', 'popup.js', 'popup.css',
]
if (existsSync(output)) throw new Error('companion_output_already_exists')
mkdirSync(output, { recursive: true })
try {
  for (const asset of assets) cpSync(path.join(source, asset), path.join(output, asset))
  cpSync(path.join(source, 'icons'), path.join(output, 'icons'), { recursive: true })
  cpSync(path.join(source, '_locales'), path.join(output, '_locales'), { recursive: true })
  const worker = sourceWorker.replace(expected, 'const PORTS = [8766];')
  writeFileSync(path.join(output, 'background.js'), worker)
  // Make the popup unambiguously identify the isolated target. The original
  // reviewed, explicit button/permission handler is not reimplemented here.
  const popup = readFileSync(path.join(output, 'popup.js'), 'utf8')
  const anchor = '\nlocalizeDocument();\n'
  if (popup.split(anchor).length !== 2) throw new Error('companion_popup_contract_changed')
  writeFileSync(path.join(output, 'popup.js'), popup.replace(anchor, anchor + `
const companionTitle = document.querySelector('header h1');
if (companionTitle) {
  companionTitle.removeAttribute('data-i18n');
  companionTitle.textContent = 'Chat On OpenCode';
}
const companionTransferLabel = document.getElementById('signInTransferLabel');
if (companionTransferLabel) {
  companionTransferLabel.removeAttribute('data-i18n');
  companionTransferLabel.textContent = 'Bring session to Chat On OpenCode';
}
document.title = 'Chat On OpenCode Companion';
`))
  const narrow = {
    ...manifest,
    name: 'Chat On OpenCode Companion (Brave)',
    description: 'Separate companion for the isolated Chat On OpenCode provider. Requires explicit sign-in approval.',
    permissions: ['storage', 'scripting', 'alarms', 'tabs', 'tabGroups'],
    optional_permissions: ['cookies'],
    host_permissions: [
      'https://chatgpt.com/*', 'https://chat.openai.com/*',
      'http://127.0.0.1:8766/*',
    ],
  }
  delete narrow.content_scripts // This extension does not record ChatGPT conversations.
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(narrow, null, 2) + '\n')
  const proof = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'))
  if (proof.host_permissions.some(host => /8765|18765|38765/.test(host)) ||
    proof.permissions.includes('debugger') || proof.content_scripts ||
    !worker.includes('const PORTS = [8766];')) throw new Error('companion_isolation_invalid')
  console.log(JSON.stringify({
    created: true, targetPort: 8766, protocol: 14, sourceVersion: manifest.version,
    contentScripts: false, debuggerPermission: false,
    path: output,
  }))
} catch (error) {
  rmSync(output, { recursive: true, force: true })
  throw error
}
