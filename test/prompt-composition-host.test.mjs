import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import * as tavern from '../packages/tavern-loader/src/index.js'

const runtimeRoot = process.env.DSH_TAVERN_PROMPT_COMPAT_ROOT

test('real DSH systemPrompt and Cordis preserve named external sections and dispose the service', { skip: !runtimeRoot }, async () => {
  const require = createRequire(join(resolve(runtimeRoot), 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const root = new Context()
  const directory = mkdtempSync(join(tmpdir(), 'tavern-prompt-host-'))
  try {
    root.provide('sessionController', {})
    root.provide('workspaceController', {})
    root.provide('directoryPickerController', {})
    await root.plugin(SystemPrompt, { persona: 'HOST_PERSONA', personaPrefix: 'HOST_PERSONA' })
    const plugin = root.plugin(tavern, { storageDir: directory })
    await plugin
    const service = root.get('pmpDshTavernPrompt')
    assert.ok(service)
    const unregister = service.registerComposer({ id: 'host-test', compose: () => ({ sections: [{ id: 'first', text: 'EXTERNAL_A' }, { id: 'second', text: 'EXTERNAL_B' }] }) })
    service.setMode('synthetic-session', { mode: 'external', owner: 'host-test', expectedRevision: service.getMode('synthetic-session').revision })
    const agent = { id: 'synthetic-session', session: { id: 'synthetic-session', header: {}, deriveMessages: () => [] } }
    const assembly = await root.systemPrompt.assemble({ agent })
    assert.equal(assembly.sections.find(section => section.text === 'HOST_PERSONA')?.text, 'HOST_PERSONA')
    assert.deepEqual(assembly.sections.filter(section => section.name.includes(':external:')).map(section => section.text), ['EXTERNAL_A', 'EXTERNAL_B'])
    assert.equal(assembly.sections.find(section => section.name === tavern.PROFILE_SECTION)?.text, '')
    const rendered = renderPrompt(assembly)
    assert.ok(JSON.stringify(rendered).includes('EXTERNAL_A'))
    unregister()
    await assert.rejects(root.systemPrompt.assemble({ agent }), { code: 'PROMPT_COMPOSER_UNAVAILABLE' })
    service.setMode(agent.id, { mode: 'builtin', expectedRevision: service.getMode(agent.id).revision })
    await plugin.dispose()
    assert.equal(root.get('pmpDshTavernPrompt'), undefined)
    const restored = await root.systemPrompt.assemble({ agent })
    assert.equal(restored.sections.some(section => section.name.startsWith('pmp-dsh-tavern:')), false)
  } finally {
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
