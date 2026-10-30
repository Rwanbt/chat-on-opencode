import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCodingTools, codingInstructions } from '../src/native-tools.mjs'

// The owner's real OpenCode profile declares tools whose descriptions are far
// longer than a bare profile: Skill lists every installed skill, Execute and
// Subagent document whole catalogs, and Update_goal_plan has a deep schema.
const names = ['Clear_goal', 'Create_goal', 'Edit', 'Experimental_image_generate', 'Get_goal', 'Get_goal_history',
  'Glob', 'Grep', 'List_all_goals', 'Question', 'Read', 'Replace_goal', 'Set_goal', 'Shell', 'Skill', 'Stop_goal',
  'Subagent', 'Update_goal', 'Update_goal_objective', 'Update_goal_plan', 'Update_goal_status', 'Webfetch',
  'Websearch', 'Write', 'Execute']
const longText = n => ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(Math.ceil(n / 57)).slice(0, n)
const deepSchema = {
  type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['field' + i, {
    type: 'string', title: 'Field ' + i, description: longText(400), examples: ['example ' + i],
  }])),
  required: ['field0'],
}
const tools = names.map(name => ({ type: 'function', function: {
  name,
  description: name === 'Skill' ? longText(9000) : name === 'Execute' ? longText(6000)
    : name === 'Subagent' ? longText(3000) : longText(300),
  parameters: name === 'Update_goal_plan' ? deepSchema : { type: 'object', properties: { value: { type: 'string' } } },
} }))

test('a real profile with long tool descriptions is accepted, and every tool is forwarded', () => {
  const validated = validateCodingTools({ tools })
  assert.equal(validated.enabled, true)
  assert.deepEqual(validated.tools.map(tool => tool.name), names)
  const skill = validated.tools.find(tool => tool.name === 'Skill')
  assert.ok(skill.description.length <= 1024)
  assert.match(skill.description, /\[truncated\]$/)
  const plan = validated.tools.find(tool => tool.name === 'Update_goal_plan')
  assert.ok(JSON.stringify(plan.schema).length <= 4096)
  assert.deepEqual(Object.keys(plan.schema.properties), Object.keys(deepSchema.properties))
  assert.deepEqual(plan.schema.required, ['field0'])
  const text = codingInstructions(validated.tools)
  for (const name of names) assert.ok(text.includes('- ' + name + ': '), name)
  assert.ok(text.length <= 40000)
})

test('a short description is forwarded unchanged', () => {
  const validated = validateCodingTools({ tools: [{ type: 'function', function: { name: 'read', description: 'read tool' } }] })
  assert.equal(validated.tools[0].description, 'read tool')
})
