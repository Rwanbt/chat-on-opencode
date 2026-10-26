/** Minimal strict JSONC reader that retains member/container byte offsets.
 * Intentionally rejects duplicate keys and malformed input rather than reparsing
 * a sensitive user config with lossy JSON.stringify or executing JSON5.
 */
export function readJSONC(source) {
  let i = 0
  const skip = () => {
    for (;;) {
      while (/\s/.test(source[i] ?? '') && i < source.length) i++
      if (source.slice(i, i + 2) === '//') {
        i += 2
        while (i < source.length && source[i] !== '\n') i++
      } else if (source.slice(i, i + 2) === '/*') {
        const end = source.indexOf('*/', i + 2)
        if (end < 0) throw new Error('unterminated_jsonc_comment')
        i = end + 2
      } else break
    }
  }
  const string = () => {
    if (source[i] !== '"') throw new Error('jsonc_key_must_be_quoted')
    const start = i++
    for (;;) {
      if (i >= source.length) throw new Error('unterminated_jsonc_string')
      if (source[i] === '\\') { i += 2; continue }
      if (source[i++] === '"') break
    }
    try { return JSON.parse(source.slice(start, i)) }
    catch { throw new Error('invalid_jsonc_string') }
  }
  const value = () => {
    skip()
    const start = i
    const opener = source[i]
    if (opener === '{' || opener === '[') {
      i++
      const object = opener === '{'
      const close = object ? '}' : ']'
      const members = []
      const keys = new Set()
      let trailingComma = false
      skip()
      while (source[i] !== close) {
        if (i >= source.length) throw new Error('unterminated_jsonc_container')
        let key, keyStart, keyEnd
        if (object) {
          keyStart = i
          key = string()
          keyEnd = i
          if (keys.has(key)) throw new Error('duplicate_jsonc_key')
          keys.add(key)
          skip()
          if (source[i++] !== ':') throw new Error('invalid_jsonc_colon')
        }
        const child = value()
        members.push({ key, keyStart, keyEnd, node: child })
        skip()
        if (source[i] === ',') {
          i++
          trailingComma = true
          skip()
        } else {
          trailingComma = false
          if (source[i] !== close) throw new Error('invalid_jsonc_comma')
        }
      }
      i++
      return { start, end: i, closeAt: i - 1, type: object ? 'object' : 'array',
        members, trailingComma }
    }
    if (opener === '"') return { start, end: (string(), i), type: 'scalar' }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i))
    if (!match) throw new Error('invalid_jsonc_value')
    i += match[0].length
    return { start, end: i, type: 'scalar' }
  }
  const root = value()
  skip()
  if (root.type !== 'object' || i !== source.length) throw new Error('invalid_jsonc_root')
  return root
}

const member = (root, name) => root.members.find(x => x.key === name)?.node
const addition = (root, text) => ({
  at: root.closeAt,
  value: (root.members.length && !root.trailingComma ? ',' : '') + '\n' + text + '\n',
})

/** Only append our two scoped entries. Every original non-insertion byte survives. */
export function addScopedProvider(original, generated) {
  const root = readJSONC(original)
  const plugins = member(root, 'plugins')
  const providers = member(root, 'providers')
  if (plugins && plugins.type !== 'array') throw new Error('plugins_must_be_array')
  if (providers && providers.type !== 'object') throw new Error('providers_must_be_object')
  if (providers?.members.some(item => item.key === 'chat-on-opencode')) {
    throw new Error('provider_already_present')
  }
  if (original.includes('chat-on-opencode')) throw new Error('provider_name_collision_in_config')
  const plugin = JSON.stringify(generated.plugins[0])
  const provider = JSON.stringify(generated.providers['chat-on-opencode'])
  const insertions = []
  if (plugins) insertions.push(addition(plugins, '  ' + plugin))
  if (providers) insertions.push(addition(providers, '  "chat-on-opencode": ' + provider))
  const newKeys = []
  if (!plugins) newKeys.push('  "plugins": [' + plugin + ']')
  if (!providers) newKeys.push('  "providers": {"chat-on-opencode": ' + provider + '}')
  if (newKeys.length) insertions.push(addition(root, newKeys.join(',\n')))
  let result = original
  for (const edit of insertions.sort((a, b) => b.at - a.at)) {
    result = result.slice(0, edit.at) + edit.value + result.slice(edit.at)
  }
  const parsed = readJSONC(result)
  if (!member(parsed, 'plugins') || !member(parsed, 'providers')) throw new Error('jsonc_scoped_insert_failed')
  return result
}
