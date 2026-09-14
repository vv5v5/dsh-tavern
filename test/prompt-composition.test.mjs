import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, API_V3, PROFILE_SECTION, PROMPT_SERVICE_NAME, createPromptApiHandler, secureTavernApi } from '../packages/tavern-loader/src/index.js'

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tavern-prompt-v3-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const sections = [], listeners = new Map(), services = new Map(), agents = new Map()
  const ctx = {
    systemPrompt: { section: section => sections.push(section) },
    on: (name, listener) => listeners.set(name, listener), emit: () => {},
    get: name => name === 'agents' ? agents : services.get(name),
    provide: (name, face) => services.set(name, face), effect: () => {},
    logger: { info: () => {} },
  }
  const store = apply(ctx, { storageDir: directory, ...config })
  const api = services.get(PROMPT_SERVICE_NAME)
  const character = store.characterStore.import(JSON.stringify({
    name: 'Guide', description: '  中文😀 {{char}}\r\n ', personality: 'Careful', scenario: 'Laboratory',
    first_mes: 'First', alternate_greetings: [' Alternate {{user}} '], mes_example: 'Example',
    system_prompt: 'Card system', post_history_instructions: 'PHI', creator_notes: 'EDITOR ONLY',
    extensions: { depth_prompt: { prompt: 'Depth', depth: 4 }, 'x/y': { '~z': 'Unknown' } },
    custom: { preserved: true },
    character_book: { entries: [{ id: 1, keys: ['clock'], content: 'ACTIVATED', enabled: true, insertion_order: 1, position: 'after_char' }] },
  }), { id: 'card' })
  const preset = store.create({ id: 'preset', name: 'Preset' })
  store.update(preset.id, { systemPromptMode: 'replace', sampling: { temperature: 0.2 }, prompts: [{ ...preset.prompts[0], content: 'BUILTIN_ONLY' }] })
  store.userStore.create({ id: 'reader', name: 'Reader', description: 'Persona' })
  store.sessionSelections.set('s', { characterCardId: character.id, presetId: preset.id, userId: 'reader', character: { greetingIndex: 1, preferCharacterSystemPrompt: false } })
  const agent = { id: 's', status: 'idle', session: { id: 's', header: {}, deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'clock' }] }] } }
  agents.set('s', agent)
  return { directory, sections, listeners, store, api, agent, ctx }
}

function enable(api, owner = 'manager') {
  return api.setMode('s', { mode: 'external', owner, expectedRevision: api.getMode('s').revision })
}

function invoke(handler, path, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
    Object.assign(req, { url: `${API_V3}${path}`, method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...headers } })
    const responseHeaders = {}
    const res = { statusCode: 200, setHeader: (key, value) => { responseHeaders[key] = value }, end: body => resolve({ status: res.statusCode, body: JSON.parse(body), headers: responseHeaders }) }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

test('v3 returns lossless fields, unexecuted extensions, bindings, greeting and precise Unicode lengths', t => {
  const { api, store } = fixture(t)
  const source = api.getSources('s')
  assert.equal(source.documents.character.data.description, '  中文😀 {{char}}\r\n ')
  assert.equal(source.documents.character.source.raw.custom.preserved, true)
  assert.equal(source.documents.character.data.systemPrompt, 'Card system')
  assert.equal(source.selection.character.preferCharacterSystemPrompt, false)
  assert.deepEqual(source.greeting, { requestedIndex: 1, effectiveIndex: 1, text: ' Alternate {{user}} ', semantics: 'first-turn-reference' })
  const text = source.documents.character.data.description
  assert.deepEqual(source.fieldLengths['/character/data/description'], { characters: [...text].length, utf16Units: text.length, utf8Bytes: Buffer.byteLength(text) })
  assert.equal(source.fieldLengths['/character/data/extensions/x~1y/~0z'].characters, 7)
  const revision = source.revision
  source.documents.character.data.description = 'mutated'
  assert.equal(api.getSources('s').revision, revision)
  store.sessionSelections.set('s', { character: { greetingIndex: 0 } })
  assert.notEqual(api.getSources('s').revision, revision)
  assert.equal(Object.isFrozen(api), true)
  assert.equal(api.owners, undefined)
})

test('source snapshots include all effective books once and retain binding provenance', t => {
  const { store, api } = fixture(t)
  store.worldBookStore.import(JSON.stringify({ entries: { 0: { uid: 0, key: ['z'], content: 'LORE', disable: false } } }), { id: 'book' })
  store.sessionSelections.set('s', { worldBookIds: ['book'] })
  store.userWorldBooks.set('reader', ['book'])
  store.resourceWorldBooks.set('character', 'card', ['book'])
  store.resourceWorldBooks.set('preset', 'preset', ['book'])
  const source = api.getSources('s')
  assert.equal(source.documents.worldBooks.length, 1)
  assert.deepEqual(source.worldBookSelection.effectiveIds, ['book'])
  for (const key of ['explicitIds', 'userBoundIds', 'presetBoundIds', 'characterBoundIds']) assert.deepEqual(source.worldBookSelection[key], ['book'])
  assert.ok(source.documents.character.data.characterBook)
})

test('single assembly hands over once, retains Host capabilities and uses the exact captured callConfig', async t => {
  const { api, sections, listeners, store, agent } = fixture(t)
  let calls = 0, input
  api.registerComposer({ id: 'manager', compose: value => {
    calls++; input = value
    return { sections: [{ id: 'persona', text: 'EXTERNAL_ONLY' }, { id: 'lore', text: value.runtime.loreEntries.map(entry => entry.content).join('\n') }], callConfig: { temperature: 0.7 } }
  } })
  enable(api)
  const context = { agent }
  assert.equal(sections[0].text(context), '')
  const native = { name: 'deployment:persona', text: 'HOST' }
  const rp = { name: 'rp:policy', text: 'LOCK' }
  const tools = [{ name: 'tool' }], contexts = [{ name: 'host-context', text: 'CTX' }]
  const assembled = await listeners.get('system-prompt/assemble')({}, context, async () => ({ sections: [native, { name: PROFILE_SECTION, text: '' }, rp], tools, contexts, variables: { x: 'y' } }))
  assert.equal(calls, 1)
  assert.equal(input.runtime.kind, 'assembly')
  assert.equal(input.runtime.greetingReferenceApplies, true)
  assert.ok(input.runtime.loreEntries.some(entry => entry.content === 'ACTIVATED'))
  assert.equal(assembled.sections[2].name, 'pmp-dsh-tavern:external:manager:persona')
  assert.equal(assembled.sections[3].text, 'ACTIVATED')
  assert.equal(assembled.sections[0], native)
  assert.equal(assembled.sections.at(-1), rp)
  assert.equal(assembled.tools, tools)
  assert.equal(assembled.contexts, contexts)
  assert.doesNotMatch(assembled.sections.map(section => section.text).join('\n'), /BUILTIN_ONLY|EDITOR ONLY/)
  store.sessionSelections.set('s', { presetId: null })
  const config = await listeners.get('agent/request')({ agent, turn: 1, step: 1 }, async () => ({ model: 'model', temperature: 0.1 }))
  assert.equal(config.temperature, 0.7)
  const trace = store.traceStore.list('s')[0]
  assert.equal(trace.assembly.composition.owner, 'manager')
  assert.equal(trace.assembly.composition.sourceRevision, input.sources.revision)
  assert.equal(JSON.stringify(trace).includes('EXTERNAL_ONLY'), false)
  assert.equal(calls, 1)
  agent.session.deriveMessages = () => [{ role: 'assistant', content: [] }]
  sections[0].text({ agent })
  assert.equal(input.runtime.greetingReferenceApplies, false)
})

test('external mode is persistent, isolated, CAS guarded, and never silently falls back after unload', t => {
  const { api, store, ctx, directory, agent, sections } = fixture(t)
  const unregister = api.registerComposer({ id: 'manager', compose: () => ({ sections: [] }) })
  assert.throws(() => api.registerComposer({ id: 'manager', compose() {} }), { code: 'PROMPT_COMPOSER_CONFLICT' })
  const old = api.getMode('s').revision
  enable(api)
  assert.equal(api.getMode('other').mode, 'builtin')
  assert.throws(() => api.setMode('s', { mode: 'builtin', expectedRevision: old }), { code: 'PROMPT_REVISION_CONFLICT' })
  agent.status = 'running'
  assert.throws(() => api.setMode('s', { mode: 'builtin', expectedRevision: api.getMode('s').revision }), { code: 'PROMPT_AGENT_RUNNING' })
  agent.status = 'idle'
  unregister(); unregister()
  assert.equal(api.getMode('s').available, false)
  assert.throws(() => sections[0].text({ agent }), { code: 'PROMPT_COMPOSER_UNAVAILABLE' })
  // v1 active preview remains usable to restore selection when composer is absent.
  assert.ok(store.profileLoader.activeView('s').selection)
  const restarted = apply(ctx, { storageDir: directory }).promptComposition
  assert.equal(restarted.getMode('s').mode, 'external')
  assert.equal(restarted.getMode('s').available, false)
  api.setMode('s', { mode: 'builtin', expectedRevision: api.getMode('s').revision })
  assert.match(sections[0].text({ agent }), /BUILTIN_ONLY/)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'prompt-composition.json'))).sessions, {})
})

test('invalid external outputs fail closed without leaking plugin error contents', async t => {
  const { api, sections, agent } = fixture(t, { limits: { maxProfileBytes: 32 } })
  const outputs = [
    () => { throw new Error('PRIVATE BODY') },
    () => Promise.reject(new Error('PRIVATE ASYNC BODY')),
    () => ({ sections: [{ id: 'x', text: 'x' }, { id: 'x', text: 'y' }] }),
    () => ({ sections: [{ id: 'x', text: '😀'.repeat(9) }] }),
    () => ({ sections: [], callConfig: { model: 'unowned' } }),
    () => ({ sections: [], callConfig: { stop: [1] } }),
    () => ({ sections: [], callConfig: { maxTokens: -1 } }),
    () => ({ sections: [], history: ['unowned'] }),
  ]
  for (const compose of outputs) {
    const unregister = api.registerComposer({ id: 'manager', compose })
    enable(api)
    assert.throws(() => sections[0].text({ agent }), error => error.code.startsWith('PROMPT_') && !error.message.includes('PRIVATE'))
    unregister()
  }
  await new Promise(resolve => setImmediate(resolve))
})

test('source reads do not invoke composers and observers have isolated disposal', t => {
  const { api, sections, agent } = fixture(t)
  let calls = 0, notices = 0
  const stop = api.subscribe(() => { notices++ })
  api.subscribe(() => { throw new Error('observer') })
  api.registerComposer({ id: 'manager', compose: () => { calls++; return { sections: [] } } })
  enable(api)
  const prior = notices
  stop(); stop()
  api.getSources('s'); api.getSources('s')
  assert.equal(calls, 0)
  sections[0].text({ agent })
  assert.equal(calls, 1)
  assert.equal(notices, prior)
})

test('HTTP v3 enforces explicit sessions, errors, no-store, CAS and existing origin security', async t => {
  const { store, api } = fixture(t)
  const handler = secureTavernApi(createPromptApiHandler(store.promptComposition, { ensureSession: async id => {
    if (id !== 's') throw Object.assign(new Error('not found'), { status: 404, code: 'PROMPT_SESSION_NOT_FOUND' })
  } }))
  assert.equal((await invoke(handler, '/capabilities')).body.apiVersion, 3)
  const source = await invoke(handler, '/sessions/s/prompt-sources')
  assert.equal(source.status, 200)
  assert.equal(source.headers['Cache-Control'], 'no-store')
  assert.equal((await invoke(handler, '/sessions/missing/prompt-sources')).status, 404)
  assert.equal((await invoke(handler, '/sessions/%ZZ/prompt-sources')).status, 400)
  assert.equal((await invoke(handler, '/sessions/s/prompt-sources', 'POST')).status, 405)
  assert.equal((await invoke(handler, '/unknown')).status, 404)
  assert.equal((await invoke(handler, '/sessions/s/prompt-mode', 'PUT', '{')).status, 400)
  assert.equal((await invoke(handler, '/sessions/s/prompt-mode', 'PUT', { mode: 'external', owner: 'absent', expectedRevision: api.getMode('s').revision })).body.code, 'PROMPT_COMPOSER_UNAVAILABLE')
  api.registerComposer({ id: 'manager', compose: () => ({ sections: [] }) })
  const request = { mode: 'external', owner: 'manager', expectedRevision: api.getMode('s').revision }
  assert.equal((await invoke(handler, '/sessions/s/prompt-mode', 'PUT', request, { origin: 'https://elsewhere.invalid' })).status, 403)
  assert.equal((await invoke(handler, '/sessions/s/prompt-mode', 'PUT', request)).status, 200)
  assert.equal((await invoke(handler, '/sessions/s/prompt-mode', 'PUT', request)).status, 409)
})

test('missing selections and corrupted ownership storage are explicit errors', t => {
  const { api, store, directory, ctx } = fixture(t)
  store.sessionSelections.set('s', { characterCardId: 'missing' })
  assert.throws(() => api.getSources('s'), { code: 'PROMPT_RESOURCE_MISSING' })
  assert.equal(api.getSources('unbound').documents.character, null)
  writeFileSync(join(directory, 'prompt-composition.json'), '{broken')
  assert.throws(() => apply(ctx, { storageDir: directory }), SyntaxError)
})

test('source metadata limits reject the whole snapshot and external output counts separators', t => {
  const { api, store, sections, agent } = fixture(t, { limits: { maxProfileBytes: 4 } })
  const original = store.characterStore.get.bind(store.characterStore)
  store.characterStore.get = id => ({ ...original(id), huge: 'x'.repeat(16 * 1024 * 1024) })
  assert.throws(() => api.getSources('s'), { code: 'PROMPT_SOURCES_TOO_LARGE' })
  store.characterStore.get = original
  const stop = api.registerComposer({ id: 'manager', compose: () => ({ sections: [{ id: 'a', text: 'a' }, { id: 'b', text: 'bb' }] }) })
  enable(api)
  assert.throws(() => sections[0].text({ agent }), { code: 'PROMPT_OUTPUT_TOO_LARGE' })
  stop()
  api.registerComposer({ id: 'manager', compose: () => ({ sections: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }] }) })
  assert.equal(sections[0].text({ agent }), '')
})

test('published example registers without enabling sessions and composes only its explicit fields', async t => {
  const { api, agent, store } = fixture(t)
  const example = await import('../docs/examples/prompt-composer.mjs')
  let dispose
  example.apply({ get: () => api, effect: setup => { dispose = setup() } })
  assert.equal(api.getMode('s').mode, 'builtin')
  enable(api, 'example-manager')
  const compiled = store.profileLoader.compile({ agent })
  assert.ok(compiled.externalSections.some(section => section.name.endsWith(':description')))
  assert.ok(compiled.externalSections.some(section => section.name.endsWith(':greeting-reference')))
  assert.doesNotMatch(compiled.systemText, /EDITOR ONLY|Card system|\{\{char\}\}/)
  assert.equal(compiled.callConfig.temperature, 0.2)
  dispose()
  assert.equal(api.getMode('s').available, false)
})

test('external composition retains imported context and its original claim/consume lifecycle', async t => {
  const { directory, ctx, sections, listeners, agent } = fixture(t)
  const { ImportContextRuntime } = await import('../packages/tavern-loader/src/import-context-runtime.js')
  const content = JSON.stringify({ schemaVersion: 1, greeting: null, qa: [{ user: 'IMPORTED_USER', assistant: 'IMPORTED_ASSISTANT' }] })
  const workspace = { readFile: path => ({ path, content }) }
  const imported = new ImportContextRuntime(directory, workspace)
  imported.bind('s', imported.prepare('context.json'))
  const store = apply(ctx, { storageDir: directory })
  store.playWorkspaceStore.readFile = workspace.readFile
  store.profileLoader.activationContextProvider = () => ({ text: 'clock', metadata: { claimEventSeqs: [12] } })
  const api = ctx.get(PROMPT_SERVICE_NAME)
  api.registerComposer({ id: 'manager', compose: ({ sources }) => {
    assert.equal(JSON.stringify(sources).includes('IMPORTED_USER'), false)
    return { sections: [{ id: 'character', text: 'EXTERNAL' }] }
  } })
  enable(api)
  const context = { agent }
  const text = sections[2].text(context)
  assert.match(text, /IMPORTED_USER/)
  assert.doesNotMatch(text, /BUILTIN_ONLY/)
  const assembly = await listeners.get('system-prompt/assemble')({}, context, async () => ({ sections: [{ name: PROFILE_SECTION, text }], contexts: [], tools: [], variables: {} }))
  assert.equal(assembly.sections[0].text, text)
  assert.equal(assembly.sections[1].text, 'EXTERNAL')
  listeners.get('session/event')(agent.session, { type: 'turn/end', seq: 20, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(sections[2].text({ agent }), '')
  assert.equal(new ImportContextRuntime(directory, workspace).binding('s').state, 'consumed')
})

test('loader routes v3 through its secured prefix and validates sessions via the public controller', async t => {
  const { directory, ctx } = fixture(t)
  let handler, inspections = 0
  ctx.provide('webServer', { register: route => { handler = route.handler; return () => {} } })
  ctx.provide('sessionController', { inspect: async id => {
    inspections++
    assert.equal(id, 's')
    return { meta: { version: 3 }, events: [] }
  } })
  ctx.effect = setup => setup()
  apply(ctx, { storageDir: directory })
  const result = await invoke(handler, '/sessions/s/prompt-sources')
  assert.equal(result.status, 200)
  assert.equal(result.body.sources.documents.character.id, 'card')
  assert.equal(inspections, 1)
  assert.equal((await invoke(handler, '/capabilities')).status, 200)
  assert.equal(inspections, 1)
  assert.equal((await invoke(handler, '/sessions/s/prompt-sources', 'GET', undefined, { host: 'elsewhere.invalid' })).status, 403)
})
