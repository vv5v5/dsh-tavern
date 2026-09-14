import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { API_V3, PLUGIN_ID } from '../../identity.js'
import { composeWorldBookSelection } from './user-world-book-policy.js'
import { projectPresetCallConfig } from './profile-compiler.js'
import { httpError, readBoundedJson, sendJson, sendPlayError } from '../../play/src/http.js'

export const PROMPT_SERVICE_NAME = 'pmpDshTavernPrompt'
const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const OWNER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (status, code, message) => { throw httpError(status, message, `PROMPT_${code}`) }

function sessionId(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail(400, 'SESSION_INVALID', 'A valid explicit sessionId is required')
  return value
}

function measures(text) {
  let characters = 0
  for (const _ of text) characters++
  return { characters, utf16Units: text.length, utf8Bytes: Buffer.byteLength(text, 'utf8') }
}

// JSON pointers retain array positions and escaped unknown extension keys.
function fieldLengths(value) {
  const result = {}
  const pending = [[value, '']]
  let visited = 0
  while (pending.length) {
    const [item, path] = pending.pop()
    if (++visited > 100000 || path.length > 4096) fail(413, 'SOURCES_TOO_LARGE', 'Source metadata exceeds the traversal limit')
    if (typeof item === 'string') result[path] = measures(item)
    else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        pending.push([child, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`])
        if (pending.length > 100000) fail(413, 'SOURCES_TOO_LARGE', 'Source metadata exceeds the traversal limit')
      }
    }
  }
  return result
}

function loadModes(path) {
  if (path === null) return new Map()
  try {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('Prompt mode storage exceeds limit')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data?.schemaVersion !== 1 || !record(data.sessions)) throw new Error('Invalid prompt mode storage')
    const entries = Object.entries(data.sessions)
    if (entries.length > 4096 || entries.some(([id, owner]) => !ID.test(id) || typeof owner !== 'string' || !OWNER.test(owner))) throw new Error('Invalid stored prompt modes')
    return new Map(entries)
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    // Corruption must not silently re-enable builtin injection.
    throw error
  }
}

function saveModes(path, modes) {
  if (path === null) return
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sessions: Object.fromEntries(modes) }), { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

function resource(store, id) {
  if (id === null) return null
  try { return store.get(id) } catch (error) {
    if (error?.code?.endsWith('_NOT_FOUND')) fail(409, 'RESOURCE_MISSING', 'A selected prompt resource is missing; refresh the binding')
    throw error
  }
}

/** Backend composition is synchronous: no browser/network round trip in assembly. */
export class PromptCompositionService {
  constructor({ selections, presets, characters, users, worldBooks, userWorldBooks, resourceWorldBooks,
    storageDir = null, isRunning = () => false, onChange = () => {}, maxProfileBytes = 512 * 1024 }) {
    Object.assign(this, { selections, presets, characters, users, worldBooks, userWorldBooks, resourceWorldBooks, isRunning, onChange, maxProfileBytes })
    this.owners = new Map()
    this.modePath = storageDir === null ? null : join(storageDir, 'prompt-composition.json')
    this.modes = loadModes(this.modePath)
    this.listeners = new Set()
    this.epoch = randomUUID()
    this.generation = 0
  }

  capabilities() {
    return {
      apiVersion: 3, service: PROMPT_SERVICE_NAME,
      modes: ['builtin', 'external'], lifetime: this.modePath === null ? 'loader-instance' : 'persistent-session-preference',
      composers: [...this.owners.keys()].sort(),
      maxSourceBytes: MAX_SOURCE_BYTES, maxProfileBytes: this.maxProfileBytes,
      maxSections: 64, synchronous: true, arbitraryMessageDepth: false,
    }
  }

  invalidate() {
    for (const listener of [...this.listeners]) {
      try { listener({ type: 'invalidate' }) } catch { /* Observers cannot break assembly or writes. */ }
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    try { listener({ type: 'invalidate' }) } catch {}
    return () => this.listeners.delete(listener)
  }

  registerComposer({ id, compose }) {
    if (typeof id !== 'string' || !OWNER.test(id) || typeof compose !== 'function') fail(400, 'COMPOSER_INVALID', 'Composer requires a stable id and synchronous compose function')
    if (this.owners.has(id)) fail(409, 'COMPOSER_CONFLICT', 'This composer id is already registered')
    if (this.owners.size >= 64) fail(409, 'COMPOSER_LIMIT', 'At most 64 composers may register')
    const entry = { compose }
    this.owners.set(id, entry)
    this.changed()
    return () => {
      if (this.owners.get(id) !== entry) return
      this.owners.delete(id)
      this.changed()
    }
  }

  changed() {
    this.generation++
    this.onChange()
    this.invalidate()
  }

  getMode(id) {
    sessionId(id)
    const owner = this.modes.get(id) ?? null
    return {
      mode: owner === null ? 'builtin' : 'external', owner,
      available: owner === null || this.owners.has(owner),
      revision: hash([this.epoch, this.generation, id, owner]),
    }
  }

  setMode(id, value) {
    sessionId(id)
    if (!record(value) || Object.keys(value).some(key => !['mode', 'owner', 'expectedRevision'].includes(key))) fail(400, 'MODE_INVALID', 'Expected mode, owner and expectedRevision')
    if (!['builtin', 'external'].includes(value.mode)
      || (value.mode === 'builtin' && value.owner != null)
      || (value.mode === 'external' && (typeof value.owner !== 'string' || !OWNER.test(value.owner)))) fail(400, 'MODE_INVALID', 'Invalid mode or owner')
    const current = this.getMode(id)
    if (value.expectedRevision !== current.revision) fail(409, 'REVISION_CONFLICT', 'Read the current mode and retry with its revision')
    if (this.isRunning(id)) fail(409, 'AGENT_RUNNING', 'Change composition mode after the current turn finishes')
    if (value.mode === 'external' && !this.owners.has(value.owner)) fail(409, 'COMPOSER_UNAVAILABLE', 'Register the backend composer before enabling external mode')
    if (value.mode === 'external' && !this.modes.has(id) && this.modes.size >= 4096) fail(409, 'SESSION_LIMIT', 'Too many external sessions')
    const next = value.mode === 'external' ? value.owner : null
    if (next !== current.owner) {
      const modes = new Map(this.modes)
      if (next === null) modes.delete(id)
      else modes.set(id, next)
      saveModes(this.modePath, modes)
      this.modes = modes
      this.changed()
    }
    return this.getMode(id)
  }

  getSources(id) {
    sessionId(id)
    const selection = this.selections.get(id)
    const preset = resource(this.presets, selection.presetId)
    const character = resource(this.characters, selection.characterCardId)
    const user = resource(this.users, selection.userId)
    const worldBookSelection = composeWorldBookSelection(selection.worldBookIds,
      user ? this.userWorldBooks.get(user.id) : [],
      preset ? this.resourceWorldBooks.get('preset', preset.id) : [],
      character ? this.resourceWorldBooks.get('character', character.id) : [])
    const documents = { preset, character, user, worldBooks: [] }
    // Bound aggregate allocation before fetching the next large book. Never truncate fields.
    let bytes = Buffer.byteLength(JSON.stringify(documents))
    if (bytes > MAX_SOURCE_BYTES) fail(413, 'SOURCES_TOO_LARGE', 'Selected source documents exceed the snapshot limit')
    for (const bookId of worldBookSelection.effectiveIds) {
      const document = resource(this.worldBooks, bookId)
      bytes += Buffer.byteLength(JSON.stringify(document))
      if (bytes > MAX_SOURCE_BYTES) fail(413, 'SOURCES_TOO_LARGE', 'Selected source documents exceed the snapshot limit')
      documents.worldBooks.push(document)
    }
    const data = character?.data
    const requestedIndex = selection.character.greetingIndex ?? 0
    const greetings = data ? [data.firstMessage ?? '', ...(data.alternateGreetings ?? [])] : []
    const effectiveIndex = data ? Math.min(requestedIndex, greetings.length - 1) : null
    const sources = {
      schemaVersion: 3, sessionId: id, selection, worldBookSelection, documents,
      greeting: { requestedIndex, effectiveIndex, text: effectiveIndex === null ? null : greetings[effectiveIndex], semantics: 'first-turn-reference' },
      fieldLengths: fieldLengths(documents),
      suggestedCallConfig: projectPresetCallConfig(preset),
      countUnit: 'unicode-code-points',
    }
    if (Buffer.byteLength(JSON.stringify(sources)) > MAX_SOURCE_BYTES) fail(413, 'SOURCES_TOO_LARGE', 'Source snapshot including metadata exceeds the limit')
    return structuredClone({ ...sources, revision: hash(sources) })
  }

  compose(id, runtime) {
    const mode = this.getMode(id)
    if (mode.mode === 'builtin') return null
    const entry = this.owners.get(mode.owner)
    if (!entry) fail(409, 'COMPOSER_UNAVAILABLE', 'External composer is unavailable; restore it or explicitly select builtin mode')
    const sources = this.getSources(id)
    let output
    try { output = entry.compose(structuredClone({ sources, runtime })) } catch {
      fail(502, 'COMPOSER_FAILED', 'External composer failed; no builtin fallback was injected')
    }
    if (output && typeof output.then === 'function') {
      Promise.resolve(output).catch(() => {})
      fail(422, 'OUTPUT_INVALID', 'Composer must return synchronously')
    }
    if (!record(output) || Object.keys(output).some(key => !['sections', 'callConfig'].includes(key)) || !Array.isArray(output.sections) || output.sections.length > 64) fail(422, 'OUTPUT_INVALID', 'Composer must return up to 64 sections and optional callConfig')
    const names = new Set()
    let bytes = Math.max(0, output.sections.length - 1) * 2
    const sections = output.sections.map(section => {
      if (!record(section) || Object.keys(section).some(key => !['id', 'text'].includes(key))
        || typeof section.id !== 'string' || !OWNER.test(section.id) || names.has(section.id)
        || typeof section.text !== 'string') fail(422, 'OUTPUT_INVALID', 'Sections require unique ids and text')
      names.add(section.id)
      bytes += Buffer.byteLength(section.text)
      if (bytes > this.maxProfileBytes) fail(413, 'OUTPUT_TOO_LARGE', 'External sections exceed the profile byte limit')
      return { name: `${PLUGIN_ID}:external:${mode.owner}:${section.id}`, text: section.text }
    })
    const callConfig = output.callConfig ?? {}
    if (!record(callConfig) || Object.keys(callConfig).some(key => !['temperature', 'maxTokens', 'reasoningEffort', 'stop'].includes(key))
      || ('temperature' in callConfig && (typeof callConfig.temperature !== 'number' || !Number.isFinite(callConfig.temperature)))
      || ('maxTokens' in callConfig && (!Number.isSafeInteger(callConfig.maxTokens) || callConfig.maxTokens <= 0))
      || ('reasoningEffort' in callConfig && !['low', 'medium', 'high', 'xhigh'].includes(callConfig.reasoningEffort))
      || ('stop' in callConfig && (!Array.isArray(callConfig.stop) || callConfig.stop.length > 64 || callConfig.stop.some(text => typeof text !== 'string' || Buffer.byteLength(text) > 4096)))) fail(422, 'OUTPUT_INVALID', 'Invalid external callConfig')
    return { sections, callConfig: structuredClone(callConfig), owner: mode.owner, sourceRevision: sources.revision }
  }

  dispose() {
    this.owners.clear()
    this.modes.clear()
    this.listeners.clear()
  }
}

export function isPromptApiPath(url) {
  const path = new URL(url ?? '/', 'http://localhost').pathname
  return path === API_V3 || path.startsWith(`${API_V3}/`)
}

export function createPromptApiHandler(service, { ensureSession = async () => {} } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const method = String(req.method ?? 'GET').toUpperCase()
      if (path === `${API_V3}/capabilities`) {
        if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Use GET')
        return sendJson(res, 200, { ok: true, ...service.capabilities() })
      }
      const match = path.match(new RegExp(`^${API_V3}/sessions/([^/]+)/prompt-(sources|mode)$`))
      if (!match) fail(404, 'NOT_FOUND', 'Unknown v3 endpoint')
      let id
      try { id = decodeURIComponent(match[1]) } catch { fail(400, 'SESSION_INVALID', 'Invalid encoded sessionId') }
      sessionId(id)
      if (method !== 'GET' && !(method === 'PUT' && match[2] === 'mode')) fail(405, 'METHOD_NOT_ALLOWED', 'Unsupported endpoint method')
      // Parse before checking Host state so a slow body cannot bypass the running guard.
      const body = method === 'PUT' ? await readBoundedJson(req, 2048) : null
      await ensureSession(id)
      if (match[2] === 'sources') return sendJson(res, 200, { ok: true, sources: service.getSources(id) })
      return sendJson(res, 200, { ok: true, composition: method === 'PUT' ? service.setMode(id, body) : service.getMode(id) })
    } catch (error) { return sendPlayError(res, error) }
  }
}
