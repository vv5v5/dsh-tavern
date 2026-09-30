import { OperationJournal } from '../../play/src/operation-journal.js'
import { createContractOperation, recordDiagnosticFailure } from '../../play/src/operation-contract.js'
import { AssemblyStore } from '../../tavern-trace/src/assembly-store.js'
import { AssemblyRecorder } from '../../tavern-trace/src/assembly-recorder.js'
import { createAssemblyBodyReader } from '../../tavern-trace/src/body-references.js'
import { createPromptTraceApi } from './prompt-trace-api.js'
import {
  PresetStore,
  createApiHandler as createPresetApiHandler,
} from '../../preset/src/index.js'
import { API_ROOT, API_V1, API_V3, PLUGIN_ID, PROFILE_SECTION } from '../../identity.js'
import { ChromeStore, PlayMembershipService, PlayWorkspaceStore, createChromeEventsHandler, createPlayApiHandler, isPlayApiPath } from '../../play/src/index.js'
import {
  CharacterStore,
  createCharacterAdapter,
  createCharacterApiHandler,
} from '../../character/src/index.js'
import { WorldBookStore, createWorldBookApiHandler } from '../../world-book-library/src/index.js'
import {
  UserStore,
  createUserAdapter,
  createUserApiHandler,
} from '../../user/src/index.js'
import { PresetParameterFallback } from './preset-parameter-fallback.js'
import { PresetRuntime } from './preset-runtime.js'
import { TavernProfileLoader } from './profile-loader.js'
import { SessionSelectionStore } from './session-policy.js'
import { UserWorldBookBindingStore } from './user-world-book-policy.js'
import { ResourceWorldBookBindingStore } from './resource-world-book-policy.js'
import { createWorldBookAdapter } from './world-book-adapter.js'
import { PendingInputProjection } from './pending-input-projection.js'
import { ImportContextRuntime } from './import-context-runtime.js'
import { createPlayHost } from './play-host.js'
import { secureTavernApi } from './api-security.js'
import {
  UiSettingsStore,
  createUiSettingsApiHandler,
  isUiSettingsApiPath,
} from './ui-settings.js'
import {
  ConversationSettingsStore,
  createConversationSettingsApiHandler,
  isConversationSettingsApiPath,
} from './conversation-settings.js'
import {
  TavernTraceRecorder,
  TavernTraceStore,
  createTavernTraceApiHandler,
  isTavernTraceApiPath,
} from '../../tavern-trace/src/index.js'
import {
  SessionConfigurationService,
  SessionTemplateStore,
  createSessionTemplateApiHandler,
  isSessionTemplateApiPath,
} from '../../session-template/src/index.js'
import {
  RpPolicyStore,
  createRpPolicyApiHandler,
  isRpPolicyApiPath,
} from './rp-policy-store.js'
import {
  RpModeController,
  createRpModeApiHandler,
  isRpModeApiPath,
  registerRpCommands,
  registerRpWriteGuard,
  resolveRpConfig,
  rpModeConstants,
} from './rp-mode.js'
import { prepareStorageDir } from './storage-location.js'

// ★ 2026-09-30：**如实报"我是从哪一份加载的"**。这个包曾经同时存在 `src/index.js`（package main）
//   与**旁边的同名扁平副本**（旧包布局的遗留）—— 改了一份不生效、排查半天（真机事故）。
//   照 anima 的既有做法（`已解析到 dsh-anima-rag：<path>`）打一行，任何"吃错代码"从此一行日志可见。
//   ⚠️ 用 console 而非 ctx.logger：这条要在**模块加载期**就打出来（ctx 还没有），也避免被日志级别吞掉。
console.log(`[tavern-loader] 已从 ${new URL(import.meta.url).pathname} 加载`)

export const name = PLUGIN_ID
export const inject = [
  'systemPrompt',
  'sessionController',
  'workspaceController',
  'directoryPickerController',
]

function migrateCharacterSelections(characterStore, selections) {
  for (const [sessionId, legacy] of Object.entries(characterStore.state.selectedBySessionId)) {
    try {
      const current = selections.get(sessionId)
      if (current.characterCardId === null) {
        const normalized = characterStore.normalizeSelection(legacy.characterCardId, legacy)
        selections.set(sessionId, normalized)
      }
    } catch (error) {
      if (error?.code !== 'CHARACTER_NOT_FOUND' && !(error instanceof TypeError)) throw error
    } finally {
      // Migration is one-way. Clearing the legacy binding prevents a user who
      // later unbinds in SessionSelectionStore from being rebound on restart.
      characterStore.select(sessionId, null)
    }
  }
}

function isCharacterApiPath(url) {
  const path = new URL(url ?? '/', 'http://localhost').pathname
  return path === `${API_V1}/character-selection`
    || path === `${API_V1}/characters`
    || path.startsWith(`${API_V1}/characters/`)
}

function isWorldBookApiPath(url) {
  const path = new URL(url ?? '/', 'http://localhost').pathname
  return path === `${API_V1}/world-book-selection`
    || path === `${API_V1}/world-books`
    || path.startsWith(`${API_V1}/world-books/`)
}

function isUserApiPath(url) {
  const path = new URL(url ?? '/', 'http://localhost').pathname
  return path === `${API_V1}/user-selection`
    || path === `${API_V1}/users`
    || path.startsWith(`${API_V1}/users/`)
}

export function createCharacterSelectionPolicy(characterStore, selections, resourceWorldBooks = null) {
  return {
    selection(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const selected = selections.get(sessionId)
      if (selected.characterCardId === null) return null
      try {
        return characterStore.normalizeSelection(selected.characterCardId, selected)
      } catch (error) {
        if (error?.code !== 'CHARACTER_NOT_FOUND' && !(error instanceof TypeError)) throw error
        return null
      }
    },
    select(sessionId, patch) {
      if (patch === null || patch.characterCardId === null) {
        selections.set(sessionId, { characterCardId: null, character: {} })
        return null
      }
      const normalized = characterStore.normalizeSelection(patch.characterCardId, patch)
      selections.set(sessionId, normalized)
      return normalized
    },
    selectMany(sessionIds, patch) {
      if (patch === null || patch.characterCardId === null) {
        return selections.setMany(sessionIds, { characterCardId: null, character: {} })
      }
      const normalized = characterStore.normalizeSelection(patch.characterCardId, patch)
      return selections.setMany(sessionIds, normalized)
    },
    clearResource(kind, id) {
      const sessionChanged = selections.clearResource(kind, id)
      const bindingChanged = kind === 'character'
        ? resourceWorldBooks?.clearOwner('character', id) === true
        : kind === 'character-card'
          ? resourceWorldBooks?.clearOwner('character', id) === true
          : false
      return sessionChanged || bindingChanged
    },
  }
}

export function createWorldBookSelectionPolicy(
  worldBookStore,
  selections,
  userWorldBooks = null,
  resourceWorldBooks = null,
) {
  return {
    selection(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return []
      return selections.get(sessionId).worldBookIds
    },
    select(sessionId, worldBookIds) {
      if (!Array.isArray(worldBookIds)) throw new TypeError('worldBookIds must be an array')
      if (worldBookIds.length > 100) throw new TypeError('A session can bind at most 100 world books')
      const normalized = [...new Set(worldBookIds)]
      for (const id of normalized) {
        if (typeof id !== 'string' || id === '') throw new TypeError('Every worldBookId must be a non-empty string')
        worldBookStore.get(id)
      }
      selections.set(sessionId, { worldBookIds: normalized })
      return normalized
    },
    clearResource(kind, id) {
      const sessionChanged = selections.clearResource(kind, id)
      const userChanged = kind === 'world-book' ? userWorldBooks?.clearWorldBook(id) === true : false
      const resourceChanged = kind === 'world-book' ? resourceWorldBooks?.clearWorldBook(id) === true : false
      return sessionChanged || userChanged || resourceChanged
    },
  }
}

export function createUserSelectionPolicy(userStore, selections, userWorldBooks = null) {
  return {
    selection(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      const selected = selections.get(sessionId)
      if (selected.userId === null) return null
      try {
        userStore.get(selected.userId)
        return { userId: selected.userId }
      } catch (error) {
        if (error?.code !== 'USER_NOT_FOUND' && !(error instanceof TypeError)) throw error
        return null
      }
    },
    select(sessionId, patch) {
      if (patch === null || patch.userId === null) {
        selections.set(sessionId, { userId: null })
        return null
      }
      userStore.get(patch.userId)
      selections.set(sessionId, { userId: patch.userId })
      return { userId: patch.userId }
    },
    clearResource(kind, id) {
      const sessionChanged = selections.clearResource(kind, id)
      const bindingChanged = kind === 'user' ? userWorldBooks?.clearUser(id) === true : false
      return sessionChanged || bindingChanged
    },
  }
}

export function createUserWorldBookBindingPolicy(userStore, worldBookStore, userWorldBooks) {
  if (typeof userWorldBooks?.get !== 'function' || typeof userWorldBooks?.set !== 'function') {
    throw new TypeError('User world-book policy requires a binding store')
  }
  return {
    selection(userId) {
      userStore.get(userId)
      return userWorldBooks.get(userId)
    },
    select(userId, worldBookIds) {
      userStore.get(userId)
      if (!Array.isArray(worldBookIds)) throw new TypeError('worldBookIds must be an array')
      if (worldBookIds.length > 100) throw new TypeError('A user can bind at most 100 world books')
      const normalized = [...new Set(worldBookIds)]
      for (const id of normalized) {
        if (typeof id !== 'string' || id === '') throw new TypeError('Every worldBookId must be a non-empty string')
        worldBookStore.get(id)
      }
      return userWorldBooks.set(userId, normalized)
    },
  }
}

export function createResourceWorldBookBindingPolicy(
  resourceStore,
  worldBookStore,
  resourceWorldBooks,
  kind,
) {
  if (kind !== 'preset' && kind !== 'character') throw new TypeError('Resource kind must be preset or character')
  if (typeof resourceWorldBooks?.get !== 'function' || typeof resourceWorldBooks?.set !== 'function') {
    throw new TypeError('Resource world-book policy requires a binding store')
  }
  const getResource = id => resourceStore.get(id)
  return {
    selection(resourceId) {
      getResource(resourceId)
      return resourceWorldBooks.get(kind, resourceId)
    },
    select(resourceId, worldBookIds) {
      getResource(resourceId)
      if (!Array.isArray(worldBookIds)) throw new TypeError('worldBookIds must be an array')
      if (worldBookIds.length > 100) throw new TypeError(`A ${kind} can bind at most 100 world books`)
      const normalized = [...new Set(worldBookIds)]
      for (const id of normalized) {
        if (typeof id !== 'string' || id === '') throw new TypeError('Every worldBookId must be a non-empty string')
        worldBookStore.get(id)
      }
      return resourceWorldBooks.set(kind, resourceId, normalized)
    },
  }
}

/**
 * 尾部世界书条目的**交付计划**（纯函数 —— 这一单的判据就在这里，便于自检直测）。
 *
 * 返回交给 `session.append('user/message', message, intent)` 的 surface 意图：
 *   · 记着上一轮的 seq、且它**还在当前 surface 上** ⇒ `{ op:'replace', startSeq, endSeq }`
 *     ⇒ **新节点占它的位置、它从请求面消失**（= shadowed；日志一条不删）。
 *   · 否则（首轮 / 那条被压缩掉 / 拿不到 nodes）⇒ `'append'`。
 *     ⚠️ 必须退回 append：replace 的 startSeq/endSeq **必须是当前 surface 上的节点**，
 *        拿一个已被 shadowed 的旧 seq 去 replace 会被宿主拒掉。
 */
export function planRuntimeLoreSurfaceOp({ previousSeq, surfaceNodes } = {}) {
  const nodes = Array.isArray(surfaceNodes) ? surfaceNodes : null
  const replaceable = nodes !== null && Number.isSafeInteger(previousSeq) && nodes.includes(previousSeq)
  return replaceable
    ? { surfaceOp: { op: 'replace', startSeq: previousSeq, endSeq: previousSeq }, sourceEventSeqs: [previousSeq] }
    : { surfaceOp: 'append' }
}

export function apply(ctx, config = {}) {
  const parameterFallback = new PresetParameterFallback()
  const { path: storageDir } = prepareStorageDir({
    storageDir: config.storageDir,
    logger: ctx.logger,
  })
  const operationJournal = new OperationJournal(storageDir, { enabled: config.operationLogs?.enabled !== false })
  const operationContext = (operation, meta) => createContractOperation({ logger: ctx.logger, journal: operationJournal, operation, meta })
  const startup = operationContext('plugin.start')
  startup.start()
  ctx.effect(() => () => {
    operationContext('plugin.stop').success('disposed')
    operationJournal.close()
  })
  const recordFailure = (operation, error, meta) => recordDiagnosticFailure({ logger: ctx.logger, journal: operationJournal, operation, meta }, error)
  const store = new PresetStore(storageDir)
  const characterStore = new CharacterStore(storageDir)
  const worldBookStore = new WorldBookStore(storageDir)
  const userStore = new UserStore(storageDir)
  const userWorldBooks = new UserWorldBookBindingStore(storageDir, config.userWorldBooks)
  const resourceWorldBooks = new ResourceWorldBookBindingStore(storageDir, config.resourceWorldBooks)
  const sessionTemplateStore = new SessionTemplateStore(storageDir, config.sessionTemplates)
  const uiSettingsStore = new UiSettingsStore(storageDir)
  const conversationSettingsStore = new ConversationSettingsStore(storageDir)
  const chromeStore = new ChromeStore(storageDir)
  const rpPolicyStore = new RpPolicyStore(storageDir, {
    defaultSection: resolveRpConfig(config.rpMode ?? {}).section,
  })
  const selections = new SessionSelectionStore(storageDir, {
    ...config.sessionSelections,
    defaultSelection: () => ({ presetId: store.state.selectedId }),
  })
  migrateCharacterSelections(characterStore, selections)
  const rpMode = new RpModeController({
    selections,
    uiSettings: uiSettingsStore,
    agents: () => ctx.get('agents'),
    sandboxDefault: () => ctx.get('sandboxPolicy')?.defaultMode,
    workspaceRoot: () => {
      const root = ctx.get('sandboxPolicy')?.workspaceRoot
      return typeof root === 'string' && root !== '' ? root : process.cwd()
    },
    logger: ctx.logger,
    policyStore: rpPolicyStore,
    section: rpPolicyStore.defaultSection,
  })
  const reconcileRpAfterSelection = (sessionId) => {
    const liveAgent = ctx.get('agents')?.get?.(sessionId)
    const session = liveAgent === undefined ? ctx.get('sessions')?.get?.(sessionId) : undefined
    const agent = liveAgent ?? (session === undefined ? { id: sessionId } : { id: sessionId, session })
    try {
      rpMode.onSessionStart(agent)
    } catch (error) {
      recordFailure('rp.policy', error, { sessionId })
    }
  }
  let importContexts = null
  const playHost = createPlayHost({
    sessionController: ctx.get('sessionController'),
    workspaceController: ctx.get('workspaceController'),
    directoryPickerController: ctx.get('directoryPickerController'),
    sessions: ctx.get('sessions'),
  }, {
    selections,
    characters: characterStore,
    importContexts: () => importContexts,
    onSelectionCopied: sessionId => reconcileRpAfterSelection(sessionId),
  })
  const playWorkspaceStore = new PlayWorkspaceStore(storageDir, { host: playHost })
  const playMemberships = new PlayMembershipService(playWorkspaceStore)
  importContexts = new ImportContextRuntime(storageDir, playWorkspaceStore)
  const runtime = new TavernProfileLoader({
    presetStore: store,
    selections,
    userWorldBooks,
    resourceWorldBooks,
    maxProfileBytes: config.limits?.maxProfileBytes,
  })
  const pendingInput = new PendingInputProjection({
    maxScanCharacters: config.worldBook?.maxScanCharacters,
    maxScanMessages: config.worldBook?.maxScanMessages,
    maxQueuedCharacters: config.pendingInput?.maxQueuedCharacters,
    maxQueuedMessages: config.pendingInput?.maxQueuedMessages,
  })
  runtime.registerActivationContextProvider(agent => pendingInput.activationContext(agent))
  const assemblyStore = new AssemblyStore(storageDir, config.traceAssemblies)
  const traceStore = new TavernTraceStore(storageDir, config.trace, assemblyStore)
  if (traceStore.resetOversizedFile) {
    recordFailure('trace.record', { code: 'TRACE_STORAGE_OVERSIZED' })
  }
  const traceRecorder = new TavernTraceRecorder(traceStore)
  const assemblyRecorder = new AssemblyRecorder(assemblyStore)
  runtime.registerCharacterAdapter(createCharacterAdapter(characterStore))
  runtime.registerUserAdapter(createUserAdapter(userStore))
  runtime.registerWorldBookAdapter(createWorldBookAdapter(worldBookStore, config.worldBook))
  const notifyChange = () => ctx.emit('system-prompt/change')
  const traceSafely = (callback) => {
    try {
      return callback()
    } catch (error) {
      recordFailure('trace.record', error)
      return undefined
    }
  }
  const characterSelectionPolicy = createCharacterSelectionPolicy(characterStore, selections, resourceWorldBooks)
  const worldBookSelectionPolicy = createWorldBookSelectionPolicy(
    worldBookStore,
    selections,
    userWorldBooks,
    resourceWorldBooks,
  )
  const userSelectionPolicy = createUserSelectionPolicy(userStore, selections, userWorldBooks)
  const userWorldBookBindingPolicy = createUserWorldBookBindingPolicy(userStore, worldBookStore, userWorldBooks)
  const presetWorldBookBindingPolicy = createResourceWorldBookBindingPolicy(
    store,
    worldBookStore,
    resourceWorldBooks,
    'preset',
  )
  const characterWorldBookBindingPolicy = createResourceWorldBookBindingPolicy(
    characterStore,
    worldBookStore,
    resourceWorldBooks,
    'character',
  )
  const selectCharacter = characterSelectionPolicy.select.bind(characterSelectionPolicy)
  const selectManyCharacters = characterSelectionPolicy.selectMany.bind(characterSelectionPolicy)
  characterSelectionPolicy.select = (sessionId, patch) => {
    const previousId = characterSelectionPolicy.selection(sessionId)?.characterCardId ?? null
    const result = selectCharacter(sessionId, patch)
    rpMode.followCharacterChange(sessionId, {
      previousId,
      nextId: result?.characterCardId ?? null,
    })
    return result
  }
  characterSelectionPolicy.selectMany = (sessionIds, patch) => {
    const previous = new Map(sessionIds.map(sessionId => [sessionId, characterSelectionPolicy.selection(sessionId)?.characterCardId ?? null]))
    const result = selectManyCharacters(sessionIds, patch)
    for (const sessionId of sessionIds) {
      rpMode.followCharacterChange(sessionId, {
        previousId: previous.get(sessionId) ?? null,
        nextId: result?.[sessionId]?.characterCardId ?? null,
      })
    }
    return result
  }
  const sessionConfigurations = new SessionConfigurationService({
    templates: sessionTemplateStore,
    selections,
    presets: store,
    characters: characterStore,
    users: userStore,
    worldBooks: worldBookStore,
  })

  const selectionPolicy = {
    selectedPresetId: (sessionId) => runtime.selection({ sessionId }).presetId,
    selectPreset: (id, sessionId) => {
      if (id !== null) store.get(id)
      if (sessionId === null) {
        store.select(id)
      } else {
        selections.set(sessionId, { presetId: id })
      }
      return id === null ? null : store.get(id)
    },
    beforeSelectionChange: ({ sessionId }) => {
      const agent = ctx.get('agents')?.get?.(sessionId)
      if (agent?.status === 'running') {
        const error = new Error('The session agent is running; change the preset after the current turn finishes.')
        error.code = 'PRESET_AGENT_RUNNING'
        error.status = 409
        throw error
      }
    },
    clearResource: (kind, id) => {
      const sessionChanged = selections.clearResource(kind, id)
      const bindingChanged = kind === 'preset' ? resourceWorldBooks.clearOwner('preset', id) : false
      return sessionChanged || bindingChanged
    },
    worldBookBindingPolicy: presetWorldBookBindingPolicy,
  }

  ctx.systemPrompt.section({
    name: PROFILE_SECTION,
    order: 10,
    text: (context) => {
      const snapshot = runtime.forAssembleContext(context)
      const claimMetadata = snapshot.audit?.activation ?? null
      snapshot.importedContext = importContexts.contextFor(context.agent?.id, claimMetadata, snapshot.macroContext, context.agent?.session)
      snapshot.registeredProfileText = [snapshot.systemText, snapshot.importedContext].filter(Boolean).join('\n\n')
      return snapshot.registeredProfileText
    },
  })
  ctx.systemPrompt.section({
    name: rpModeConstants.sectionName,
    order: rpModeConstants.sectionOrder,
    text: (context) => {
      if (context.agent === undefined) return ''
      return rpMode.isActive(context.agent) ? rpMode.section : ''
    },
  })

  ctx.on('agent/created', ({ agent }) => {
    selections.ensureAgent(agent)
    pendingInput.ensureSession(agent?.session)
    // DSH awaits this serial lifecycle before exposing the Agent. A failed
    // policy initialization must fail registration, not permit an unguarded turn.
    rpMode.onSessionStart(agent)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    try {
      rpMode.onBoundary(payload.agent)
      rpMode.enforceReadOnly(payload.agent?.session)
    } catch (error) {
      recordFailure('rp.policy', error, { sessionId: payload.agent?.id })
    }
    return decision
  })

  registerRpCommands(ctx, rpMode)
  registerRpWriteGuard(ctx, rpMode)

  ctx.on('agent/request', async (payload, next) => {
    traceSafely(() => assemblyRecorder.nextRequest(payload.agent?.id))
    const snapshot = runtime.assembledFor(payload.agent) ?? runtime.compile({ agent: payload.agent })
    const config = await parameterFallback.prepare(payload, await next(), snapshot.callConfig, ctx.get('llm'))
    let legacyRecord
    traceSafely(() => { legacyRecord = traceRecorder.begin({ ...payload, snapshot }) })
    traceSafely(() => assemblyRecorder.begin({ ...payload, snapshot, legacyRecord }))
    traceSafely(() => assemblyRecorder.parameters(payload.agent?.id, parameterFallback.snapshot(payload.agent)))
    return config
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => parameterFallback.observeFrame(agent, frame))

  ctx.on('agent/error', payload => {
    traceSafely(() => assemblyRecorder.failure(payload))
  })

  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.get('agents')?.get?.(options.sessionId)
    if (agent) traceSafely(() => assemblyRecorder.parameters(options.sessionId, parameterFallback.snapshot(agent, options)))
    traceSafely(() => assemblyRecorder.request(options, ctx.get('agents')?.get?.(options.sessionId)?.session))
    yield* next()
  })
  ctx.effect(() => () => traceSafely(() => assemblyRecorder.dispose()))

  ctx.on('session/event', (session, event) => {
    pendingInput.observeSessionEvent(session, event)
    traceSafely(() => assemblyRecorder.observeSessionEvent(session, event))
    if (event?.type === 'turn/end') {
      traceSafely(() => assemblyRecorder.finish(session?.id, 'request-unconfirmed'))
      pendingInput.clearClaimed(session)
      importContexts.consumeAfterTurn(session?.id, event, session)
    }
    if (event?.type === 'sandbox/mode') {
      try { rpMode.enforceReadOnly(session) } catch (error) {
        recordFailure('rp.policy', error, { sessionId: session?.id })
      }
    }
    traceSafely(() => traceRecorder.observeSessionEvent(session, event))
  })

  ctx.on('agent/request-error', async (payload, next) => {
    const recovered = parameterFallback.recover(payload)
    if (recovered) traceSafely(() => assemblyRecorder.parameters(payload.agent?.id, parameterFallback.snapshot(payload.agent)))
    const result = recovered ? { kind: 'retry' } : await next()
    traceSafely(() => assemblyRecorder.finish(payload.agent?.id, 'request-failed-before-observation'))
    if (result?.kind === 'retry') traceSafely(() => assemblyRecorder.nextRequest(payload.agent?.id))
    traceSafely(() => traceRecorder.observeRequestError(payload.agent, payload.turn, payload.step))
    return result
  })

  // ★ vv5v5 fork（2026-09-28，缓存优化）：触发制世界书条目（绿灯）→ 对话尾部。
  //   通道与 phi-message 相同（pre-step 追加 user 消息，source.kind=plugin ⇒ 面板按来源过滤）；
  //   历史零改动 ⇒ system 稳定前缀（persona+蓝灯）不被每轮变化的触发集打断（缓存命中率 13%→90%+）。
  //   常驻条目（constant/蓝灯）仍在 system —— 它们是稳定前缀的一部分，搬走没有收益。
  //
  // ★★ 2026-09-30 **换掉而不是叠加**（真机实测：10 楼后请求里叠了 **10 份**，每份 21,623 字，
  //   光这一项占请求体 **79.5%** —— 旧写法每轮 `messages: [...messages, 新条目]` 只加不减，
  //   而上一条已作为 `user/message` 落盘成历史 ⇒ 逐楼累积）。改用宿主官方的 **surface 替换**：
  //   `session.append('user/message', …, { surfaceOp: { op:'replace', startSeq, endSeq } })`
  //   —— compaction 压历史用的同一套（`compaction-basic/src/region.ts`）：**日志一条不删，
  //   被替换的从请求面消失**（= `shadowed`）。于是请求里永远只有**最新一份**。
  //   · 上一轮的 seq **自己记**：`session.surface.nodes` 只给 seq、不给事件，认不出哪条是我们的。
  //   · 用之前先确认它**还在当前 surface 上**：被压缩掉就不再是节点，而 replace 的
  //     startSeq/endSeq 必须是**当前 surface 上的节点** ⇒ 那时退回 `'append'`（等价于首次）。
  //   ⚠️ replace 的语义是「新节点**占被替换节点的位置**」（与 compaction 的 checkpoint 同款）
  //     ⇒ 注入此后停在**它第一次出现的位置**，不再一直贴着尾部；换来的是"只有一份"。
  const tailLoreSeqBySession = new Map()
  /** 这一步的**如实账**：走 replace 还是 append、为什么（⛔ 不许静默 —— 静默回退过一次，见下）。
   *  ⚠️ 同时走 stdout 与 ctx.logger：2026-09-30 排查时 ctx.logger.info 一条都没出现，
   *     当时分不清"没跑到这里"还是"logger 被过滤"（宿主里那段确实是我改的那份代码，
   *     结果是**加载了另一份副本**）。两条都写，就不会再有这种歧义。 */
  const tailLoreLog = (m) => {
    const line = `[tavern-loader] runtime-lore: ${m}`
    try { console.log(line) } catch { /* 日志绝不许影响这一步 */ }
    try { ctx.logger?.info?.(line) } catch { /* 同上 */ }
  }
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await (typeof next === 'function' ? next() : Promise.resolve({ kind: 'enter', messages: payload?.messages ?? [] }))
    try {
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      const agent = payload?.agent
      if (agent === undefined || agent === null) return decision
      const snapshot = runtime.assembledFor(agent) ?? runtime.compile({ agent })
      const entries = snapshot.runtimeLore ?? []
      if (entries.length === 0) return decision
      const text = entries.map((entry) => {
        const rendered = typeof entry.content === 'string' ? entry.content : ''
        return rendered === '' ? null : '〔世界书 · ' + String(entry.resourceId ?? '?') + '〕' + rendered
      }).filter(Boolean).join('\n\n')
      if (text === '') return decision
      const message = {
        // 宿主不会替 pre-step 决策消息补 id；缺 id 的消息落盘过不了 V4 校验，resume 直接拒载（2026-09-29 踩过）。
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: '[本轮激活的世界书条目 —— 世界事实，供描写参考]\n\n' + text + '[/本轮激活的世界书条目]' }],
        source: { kind: 'plugin:pmp-dsh-tavern', form: 'runtime-lore' },
      }
      const session = agent.session
      if (session === undefined || session === null || typeof session.append !== 'function') {
        // 拿不到会话（宿主形状变了）⇒ 退回老路：塞进 decision.messages，宁可叠加也不静默丢内容。
        // ⚠️ 这条**必须留痕**：它是"每轮叠加"的老行为，静默回退过一次（2026-09-30 验收不通过时查了半小时）。
        tailLoreLog(`no session.append ⇒ 退回 decision.messages（entries=${entries.length}, session=${typeof session}）`)
        const messages = Array.isArray(decision.messages) ? decision.messages : []
        return { ...decision, messages: [...messages, message] }
      }
      const previous = tailLoreSeqBySession.get(session.id)
      const nodes = session.surface?.nodes
      const appended = session.append('user/message', message, planRuntimeLoreSurfaceOp({
        previousSeq: previous,
        surfaceNodes: nodes,
      }))
      if (Number.isSafeInteger(appended?.seq)) tailLoreSeqBySession.set(session.id, appended.seq)
      // ★ 一行如实账：走的是 replace（换掉旧的）还是 append（首次/旧的已不在 surface 上）。
      tailLoreLog(`entries=${entries.length} prev=${String(previous)} nodes=${Array.isArray(nodes) ? nodes.length : 'n/a'}`
        + ` ⇒ ${Number.isSafeInteger(previous) && Array.isArray(nodes) && nodes.includes(previous) ? 'replace' : 'append'}`
        + ` seq=${String(appended?.seq)}`)
      // ⛔ 不要再把这条塞进 decision.messages —— 那条路会被 agent-loop 逐条 append 成**新的**历史事件。
      return decision
    } catch (error) {
      // ⛔ 不许静默：这条路径出错时**必须**留下原因（否则表现就是"照旧叠加"，谁也看不出是为什么）。
      tailLoreLog(`threw: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const snapshot = runtime.forAssembleContext(context)
    const contexts = snapshot.runtimeContexts.length === 0
      ? assembly.contexts
      : [...assembly.contexts, ...snapshot.runtimeContexts]
    // Expand only our untouched contribution at its existing position. A third
    // party that already replaced it owns that replacement.
    const sections = assembly.sections.flatMap(section => {
      if (section.name !== PROFILE_SECTION) return [section]
      if (section.text !== snapshot.registeredProfileText) return [section]
      const imported = snapshot.importedContext
      return [...snapshot.sections.map(({ name, text }) => ({ name, text })),
        ...(imported ? [{ name: PROFILE_SECTION, text: imported }] : [])]
    })
    const selected = snapshot.systemPromptMode === 'replace'
      ? sections.filter(s => s.name === PROFILE_SECTION || s.name.startsWith(`${PLUGIN_ID}:part:`) || s.name === rpModeConstants.sectionName)
      : sections
    // Publish our named contributions before downstream listeners execute.
    // Keep the official shared assembly object so later plugins can transform it.
    assembly.sections = selected
    assembly.contexts = contexts
    const result = await next()
    // Ancestor transforms and complete-section enforcement may still follow.
    snapshot.officialAssembly = structuredClone(result)
    return result
  })

  const registerHttpApi = webCtx => {
    const promptTraceApi = createPromptTraceApi({ assemblies: assemblyStore, legacyStore: traceStore,
      readBodies: createAssemblyBodyReader(ctx.get('sessionController')) })
    const presetApi = createPresetApiHandler(
      store,
      notifyChange,
      (sessionId) => runtime.activeView(sessionId),
      selectionPolicy,
    )
    const characterApi = createCharacterApiHandler(characterStore, {
      onChange: notifyChange,
      logger: ctx.logger,
      selectionPolicy: characterSelectionPolicy,
      relinkCharacter: (previousCharacterId, character) => playMemberships.relinkCharacter(previousCharacterId, character, {
        selectionPolicy: characterSelectionPolicy,
      }),
      worldBookBindingPolicy: characterWorldBookBindingPolicy,
      beforeSelectionChange: ({ sessionId, characterCardId }) => {
        const agent = ctx.get('agents')?.get?.(sessionId)
        if (agent?.status === 'running') {
          const error = new Error('The session agent is running; change the character after the current turn finishes.')
          error.code = 'CHARACTER_AGENT_RUNNING'
          error.status = 409
          throw error
        }
        const conflicts = playMemberships.conflictsForSelection(sessionId, characterCardId)
        if (conflicts.length > 0) {
          const error = new Error('Changing this character will detach the session and its descendant branches from the playthrough.')
          error.code = 'CHARACTER_PLAYTHROUGH_DETACH_REQUIRED'
          error.status = 409
          error.details = { conflicts }
          throw error
        }
      },
    })
    const worldBookApi = createWorldBookApiHandler(worldBookStore, {
      onChange: notifyChange,
      selectionPolicy: worldBookSelectionPolicy,
      beforeSelectionChange: ({ sessionId }) => {
        const agent = ctx.get('agents')?.get?.(sessionId)
        if (agent?.status === 'running') {
          const error = new Error('The session agent is running; change world books after the current turn finishes.')
          error.code = 'WORLD_BOOK_AGENT_RUNNING'
          error.status = 409
          throw error
        }
      },
    })
    const userApi = createUserApiHandler(userStore, {
      onChange: notifyChange,
      selectionPolicy: userSelectionPolicy,
      worldBookBindingPolicy: userWorldBookBindingPolicy,
      beforeSelectionChange: ({ sessionId }) => {
        const agent = ctx.get('agents')?.get?.(sessionId)
        if (agent?.status === 'running') {
          const error = new Error('The session agent is running; change the user after the current turn finishes.')
          error.code = 'USER_AGENT_RUNNING'
          error.status = 409
          throw error
        }
      },
    })
    const traceApi = createTavernTraceApiHandler(traceStore)
    const sessionTemplateApi = createSessionTemplateApiHandler(sessionTemplateStore, sessionConfigurations, {
      onChange: change => {
        if (change.kind === 'session-configuration-applied') {
          notifyChange()
          reconcileRpAfterSelection(change.sessionId)
        }
      },
    })
    const uiSettingsApi = createUiSettingsApiHandler(uiSettingsStore)
    const conversationSettingsApi = createConversationSettingsApiHandler(conversationSettingsStore)
    const playApi = createPlayApiHandler({
      chromeStore,
      workspaceStore: playWorkspaceStore,
      operationJournal,
      host: playHost,
      logger: ctx.logger,
      membershipService: playMemberships,
      resolveCharacter: characterId => characterStore.list().find(item => item.id === characterId) ?? null,
      relinkPlaythrough: (playthroughId, character, { operation }) => playMemberships.relinkPlaythrough(playthroughId, character, {
        operation,
        selectionPolicy: characterSelectionPolicy,
      }),
    })
    const rpPolicyApi = createRpPolicyApiHandler(rpPolicyStore, { onChange: notifyChange })
    const rpModeApi = createRpModeApiHandler(rpMode, {
      beforeChange: ({ sessionId, active }) => {
        notifyChange()
        if (typeof sessionId !== 'string' || typeof active !== 'boolean') return
      },
    })
    const api = secureTavernApi(
      (req, res) => new URL(req.url, 'http://localhost').pathname.startsWith(`${API_V3}/`)
        ? promptTraceApi(req, res)
        : isPlayApiPath(req.url)
        ? playApi(req, res)
        : isUiSettingsApiPath(req.url)
        ? uiSettingsApi(req, res)
        : isConversationSettingsApiPath(req.url)
          ? conversationSettingsApi(req, res)
        : isRpPolicyApiPath(req.url)
          ? rpPolicyApi(req, res)
        : isRpModeApiPath(req.url)
          ? rpModeApi(req, res)
        : isSessionTemplateApiPath(req.url)
          ? sessionTemplateApi(req, res)
        : isUserApiPath(req.url)
        ? userApi(req, res)
        : isTavernTraceApiPath(req.url)
          ? traceApi(req, res)
          : isCharacterApiPath(req.url)
            ? characterApi(req, res)
            : isWorldBookApiPath(req.url)
              ? worldBookApi(req, res)
              : presetApi(req, res),
      config.security,
    )
    ctx.effect(
      () => {
        const disposeRoute = webCtx.webServer.register({
          kind: 'prefix',
          path: API_ROOT,
          handler: api,
        })
        return () => {
          disposeRoute?.()
          chromeStore.dispose()
        }
      },
      'dsh-tavern: HTTP Tavern API',
    )
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerHttpApi)
  } else {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) registerHttpApi({ webServer })
  }

  startup.success('ready')
  Object.defineProperties(store, {
    operationJournal: { value: operationJournal, enumerable: false },
    profileLoader: { value: runtime, enumerable: false },
    sessionSelections: { value: selections, enumerable: false },
    characterStore: { value: characterStore, enumerable: false },
    worldBookStore: { value: worldBookStore, enumerable: false },
    userStore: { value: userStore, enumerable: false },
    userWorldBooks: { value: userWorldBooks, enumerable: false },
    resourceWorldBooks: { value: resourceWorldBooks, enumerable: false },
    sessionTemplateStore: { value: sessionTemplateStore, enumerable: false },
    sessionConfigurations: { value: sessionConfigurations, enumerable: false },
    uiSettingsStore: { value: uiSettingsStore, enumerable: false },
    conversationSettingsStore: { value: conversationSettingsStore, enumerable: false },
    chromeStore: { value: chromeStore, enumerable: false },
    playWorkspaceStore: { value: playWorkspaceStore, enumerable: false },
    rpPolicyStore: { value: rpPolicyStore, enumerable: false },
    assemblyStore: { value: assemblyStore, enumerable: false },
    traceStore: { value: traceStore, enumerable: false },
    traceRecorder: { value: traceRecorder, enumerable: false },
    pendingInputProjection: { value: pendingInput, enumerable: false },
    rpMode: { value: rpMode, enumerable: false },
  })
  return store
}

export function createApiHandler(store, onChange = () => {}) {
  const selections = new SessionSelectionStore(store.storageDir, {
    defaultSelection: () => ({ presetId: store.state.selectedId }),
  })
  const runtime = new TavernProfileLoader({ presetStore: store, selections })
  const selectionPolicy = {
    selectedPresetId: (sessionId) => runtime.selection({ sessionId }).presetId,
    selectPreset: (id, sessionId) => {
      if (id !== null) store.get(id)
      if (sessionId === null) store.select(id)
      else selections.set(sessionId, { presetId: id })
      return id === null ? null : store.get(id)
    },
    clearResource: (kind, id) => selections.clearResource(kind, id),
  }
  return createPresetApiHandler(store, onChange, (sessionId) => runtime.activeView(sessionId), selectionPolicy)
}

export { PresetRuntime } from './preset-runtime.js'
export { compilePresetForDsh, projectPresetCallConfig } from './profile-compiler.js'
export {
  TavernProfileLimitError,
  TavernProfileLoader,
  compileTavernProfile,
  conversationTextFromAgent,
  profileLoaderConstants,
} from './profile-loader.js'
export {
  SessionSelectionLimitError,
  SessionSelectionStore,
  normalizeSelection,
  sessionPolicyConstants,
} from './session-policy.js'
export {
  UserWorldBookBindingLimitError,
  UserWorldBookBindingStore,
  composeWorldBookSelection,
  userWorldBookPolicyConstants,
} from './user-world-book-policy.js'
export {
  ResourceWorldBookBindingLimitError,
  ResourceWorldBookBindingStore,
  resourceWorldBookPolicyConstants,
} from './resource-world-book-policy.js'
export { createWorldBookAdapter } from './world-book-adapter.js'
export { PendingInputProjection, pendingInputProjectionConstants } from './pending-input-projection.js'
export {
  RpPolicyStore,
  createRpPolicyApiHandler,
  isRpPolicyApiPath,
  normalizeRpPolicySection,
  rpPolicyStoreConstants,
} from './rp-policy-store.js'
export {
  DEFAULT_RP_SECTION,
  DEFAULT_RP_STATE,
  RpModeController,
  createRpModeApiHandler,
  foldSandboxMode,
  hasOpenTurn,
  isRpModeApiPath,
  normalizeRpState,
  registerRpCommands,
  registerRpWriteGuard,
  resolveRpConfig,
  RP_MUTATING_TOOL_NAMES,
  RP_WRITE_BLOCK_REASON,
  rpHighRiskGuardReason,
  rpModeConstants,
  rpWorkspaceReadGuardReason,
  rpWriteGuardReason,
} from './rp-mode.js'
export { createPlayHost } from './play-host.js'
export {
  ChromeStore,
  PlayWorkspaceStore,
  chromeConstants,
  createChromeEventsHandler,
  createPlayApiHandler,
  deriveFocus,
  isPlayApiPath,
  normalizeChrome,
  normalizeTimeline,
  playWorkspaceConstants,
  validatePlayDocument,
} from '../../play/src/index.js'
export { WorldBookStore, createWorldBookApiHandler } from '../../world-book-library/src/index.js'
export { secureTavernApi, apiSecurityConstants } from './api-security.js'
export {
  UiSettingsStore,
  createUiSettingsApiHandler,
  isUiSettingsApiPath,
  normalizeUiSettings,
  uiSettingsConstants,
} from './ui-settings.js'
export {
  ConversationSettingsStore,
  conversationSettingsConstants,
  createConversationSettingsApiHandler,
  isConversationSettingsApiPath,
  normalizeConversationSettings,
} from './conversation-settings.js'
export { TavernTraceRecorder, TavernTraceStore } from '../../tavern-trace/src/index.js'
export {
  SessionConfigurationError,
  SessionConfigurationService,
  SessionTemplateLimitError,
  SessionTemplateStore,
  createSessionTemplateApiHandler,
  sessionTemplateApiConstants,
  sessionTemplateStoreConstants,
} from '../../session-template/src/index.js'
export { PresetStore } from '../../preset/src/index.js'
export {
  API_ROOT,
  API_V1,
  API_V2,
  CLIENT_REFRESH_EVENT,
  CLIENT_UI_SETTINGS_EVENT,
  CLIENT_CONVERSATION_SETTINGS_EVENT,
  LEGACY_API_ROOT,
  PLUGIN_ID,
  PROFILE_SECTION,
  identityConstants,
} from '../../identity.js'
