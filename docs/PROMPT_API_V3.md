# v3 提示词来源与外部组合 API

状态：2.3.0 候选实现，2026-09-14；待用户最终验收，未发布。HTTP `/v3` 是新增合同版本，与 Tavern 软件版本和 DSH 会话存储 V3 无关。[English](PROMPT_API_V3_en.md)

## 需求与选择

提示词管理器需要完整角色卡及绑定信息，不能从最终 `pmp-dsh-tavern:profile` 文本反推。本次将需求扩展为以下明确范围：

| 需求 | 实现与边界 |
| --- | --- |
| 检查某会话绑定了什么 | 显式 sessionId 的原子来源快照；不依赖当前 UI focus |
| 保留原文字段和未知扩展 | 返回当前归一化文档与所保留的 `source.raw`；不 trim、不展开宏、不删禁用字段；JSON 表示不承诺导入文件的空白/字节排版 |
| 字段预算与来源审计 | 每个字符串的 JSON Pointer、Unicode 码点数、UTF-16 单元和 UTF-8 字节数；不将字数称为 tokenizer token 数 |
| 开场白编排 | 同时返回请求序号、有效序号和原文；运行时单独告诉接管者本轮是否适用 |
| 预设、用户、多本世界书一起布局 | 完整文档、显式/用户/预设/角色卡关系、去重后的书列表；内嵌书保留在卡中 |
| 本轮动态 lore | 接管回调获取同一次匹配结果、匹配审计和 claimed 输入激活摘要，不让浏览器预测 |
| 接管注入与采样 | 每会话唯一 owner，返回有序命名 system sections 与可选采样参数；取消默认 profile 编译与默认 preset replace |
| 多插件冲突、切卡、重连 | 注册唯一 ID、模式 CAS、资源 revision、明确 sessionId、可释放订阅；下一次 assembly 重读来源 |
| 失败、卸载、重启恢复 | 偏好持久化；owner 缺失/回调错误停止本次组装；显式恢复 builtin；不静默切换提示词 |
| 原生 DSH 兼容 | 不复制/修改历史，不接管工具和 RP 策略；旧 v1/v2 继续存在 |

选择新增 v3 专门处理来源/组合合同，而不是将 v2 的扮演操作或 v1 的 UI 查询升级重命名。内置编译器默认保持现有字节形状；外部模式用结构化命名段落解决可观测性与重排问题。

本次没有实现 ST 的完整消息拓扑、任意深度插入、角色消息伪造、工具权限控制、远端 URL 回调、浏览器提交最终提示词、多人协作事务或资源批量编辑。这些能力不能由一个新接口虚构宿主支持。多个观察者可以同时读取，但一个会话只选一个组合器；进一步的子插件排序由该组合器负责。

## HTTP 合同

根路径 `/pmp-dsh-tavern/api/v3`，沿用 Tavern 的 TCP peer/Host/Origin/Content-Type 防护及 Host 访问控制。响应 `Cache-Control: no-store`。本 API 没有独立 API key，也不会放宽跨源访问。

| 方法 | 路径 | 成功响应 |
| --- | --- | --- |
| GET | `/capabilities` | `{ ok: true, apiVersion: 3, service, modes, lifetime, composers, maxSourceBytes, maxProfileBytes, maxSections, synchronous, arbitraryMessageDepth }` |
| GET | `/sessions/:id/prompt-sources` | `{ ok: true, sources }` |
| GET | `/sessions/:id/prompt-mode` | `{ ok: true, composition: { mode, owner, available, revision } }` |
| PUT | `/sessions/:id/prompt-mode` | `{ mode, owner?, expectedRevision }` → 同 GET |

`:id` 必须 URL 编码且符合 `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`；不接受缺省会话。HTTP 请求先经公共 `session.inspect` 检查真实会话存在，因此离线或不具备 Host controller 时不可当成纯静态文件服务器使用；检查成本可能随历史长度增长。后端 service 是本机可信插件接口，不做异步 Host existence 查询；调用者须传真实 sessionId。

`mode` 为 `builtin|external`；builtin 的 owner 必须省略或为 null；external 必须指定已注册组合器 ID。`revision` 是不透明模式 CAS 凭据，不可用 sources revision 代替。注册/卸载其他组合器也会使模式 revision 失效；409 后重新读取并让应用按用户意图重试。模式相同的写入幂等，仍检查 CAS 与运行状态。

### sources

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 3 |
| `sessionId` | 目标 DSH 会话 |
| `selection` | 原始会话绑定：presetId、characterCardId、userId、worldBookIds、character 开关、RP 状态；未显式保存 preset 时沿用现有默认选择逻辑 |
| `worldBookSelection` | explicitIds、userBoundIds、presetBoundIds、characterBoundIds、effectiveIds、duplicateIds、order |
| `documents` | `{ preset, character, user, worldBooks }`；前三者未绑定为 null；worldBooks 为按 effectiveIds 排序的完整独立书文档数组 |
| `greeting` | `{ requestedIndex, effectiveIndex, text, semantics: 'first-turn-reference' }`；0 是 firstMessage，1 开始是 alternateGreetings；超出范围夹到最后一个；无角色时有效序号/正文为 null |
| `fieldLengths` | 以 documents 为根的 JSON Pointer → `{ characters, utf16Units, utf8Bytes }`。数组用数字下标，`~`/`/` 按 JSON Pointer 转义 |
| `suggestedCallConfig` | 当前预设可映射的 temperature、maxTokens、reasoningEffort、stop；建议值，不自动应用于 external |
| `countUnit` | `unicode-code-points`；emoji 合字/组合音标可能含多个码点 |
| `revision` | 整份 sources（不含 revision 自身）的 SHA-256；资源/绑定变化会变化，不是 HTTP ETag 或模型请求 ID |

例如角色字段位于 `documents.character.data.description`、`personality`、`scenario`、`firstMessage`、`alternateGreetings`、`messageExample`、`systemPrompt`、`postHistoryInstructions`、`creatorNotes`、`extensions.depth_prompt`。`source.raw` 保留导入 JSON 中未知字段；若资源后来经过归一化编辑，应以当前 `data`/`prompts`/`book` 为当前语义值，不能用导入快照覆盖编辑。禁用偏好和 disabled prompt 都保留给管理器审阅，返回正文不意味着应注入模型。

快照上限 16 MiB（含字段元数据），遍历上限 100000 节点/JSON Pointer 4096 字符，超限整体 413，绝不截断字段。没有历史正文、claim 正文、凭据、磁盘日志路径或执行工具。读快照不匹配世界书、不运行组合器、不展开随机宏，也不消耗开场白。sources revision 不描述历史/激活状态；不要用它缓存本轮 lore。

### 浏览器读取与模式控制

```js
const base = '/pmp-dsh-tavern/api/v3'
async function request(path, init = {}) {
  const response = await fetch(base + path, {
    credentials: 'same-origin', cache: 'no-store', ...init,
    headers: { Accept: 'application/json', ...init.headers },
  })
  const result = await response.json()
  if (!response.ok || !result.ok) {
    throw Object.assign(new Error(result.error), { code: result.code, status: response.status })
  }
  return result
}
async function inspect(sessionId) {
  return (await request(`/sessions/${encodeURIComponent(sessionId)}/prompt-sources`)).sources
}
async function setMode(sessionId, mode, owner = null) {
  const path = `/sessions/${encodeURIComponent(sessionId)}/prompt-mode`
  const { composition } = await request(path)
  return request(path, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, owner, expectedRevision: composition.revision }),
  })
}
// 用户显式开启（先让后端插件完成注册）：
// await setMode(sessionId, 'external', 'example-manager')
// 恢复：await setMode(sessionId, 'builtin')
```

浏览器用 sources revision 对比刷新（建议面板可见时约 1 秒一次，focus/会话切换立即回读，关闭时停止，切换会话丢弃旧请求的迟到响应）。目前没有 v3 SSE/WebSocket；不要把 HTTP 轮询作为模型请求接管机制。只读审计无需打开 external 模式。

## 后端 Cordis 服务

稳定服务名 `pmpDshTavernPrompt`，由 loader `ctx.provide` 注册。插件使用 `inject: ['pmpDshTavernPrompt']` 和 `ctx.get(...)`；公开 face 冻结，不暴露存储或内部 Map。

| 方法 | 合同 |
| --- | --- |
| `capabilities()` | 同 HTTP 能力字段，不含 ok |
| `getSources(sessionId)` | 同 sources；返回独立拷贝 |
| `getMode(sessionId)` | 返回 composition |
| `setMode(sessionId, value)` | 同 HTTP 模式写入；调用者负责真实会话和用户选择 |
| `registerComposer({ id, compose })` | 注册唯一 ID 和同步回调，返回幂等 disposer；注册不启用任何会话 |
| `subscribe(listener)` | 立即发送 `{ type: 'invalidate' }`，资源 API 变更或模式/组合器变化时提醒回读；返回幂等 disposer |

订阅是失效提示，不是持久事件流或每次磁盘写的完整日志。内部 selection copy、第三方直接改文件不会全部产事件；回到前台/切换会话仍需刷新。listener 失败隔离，不阻塞写入。不发送源正文；多个 listener 独立释放。

### compose 输入与输出

同步调用 `compose({ sources, runtime })`，runtime 包含：

- `kind: 'assembly'`（直接无 agent 编译时为 `preview`）；HTTP sources 不调用它。
- `macroContext: { user, character }`，已解析当前用户/角色名称。
- `greetingReferenceApplies: boolean|null`；真实 agent 按已有 durable user/assistant 判断，preview 未知为 null。
- `loreEntries`：本次 Tavern matcher 输出的候选内容、身份和 placement；这是匹配后的候选，不是外部组合器最终采纳清单。总 profile 截取尚未执行，外部自行预算。
- `worldBookAudit`、`activation`、`diagnostics`：本次匹配审计、claimed 输入有界摘要及诊断；没有完整历史正文。

输出仅允许 `{ sections, callConfig? }`。sections 是至多 64 个 `{ id, text }`，数组顺序即提交顺序。id 是 `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`，同次输出必须唯一；最终命名为 `pmp-dsh-tavern:external:<owner>:<id>`，不允许伪装成 Host/RP section。文本和段落分隔符总 UTF-8 字节数受 loader maxProfileBytes 限制（默认 512 KiB，最大 2 MiB）。空数组是明确不注入 Tavern 资源的有效结果。

`callConfig` 只允许 temperature（有限数值）、maxTokens（正安全整数）、reasoningEffort（low/medium/high/xhigh）、stop（至多 64 个字符串，每个至多 4096 UTF-8 字节）。省略表示不覆盖 DSH/其他插件采样，不自动继续套预设参数；要沿用请返回 `sources.suggestedCallConfig`。不接受 model/provider/tools/messages。

Promise、重复 ID、超限、非法参数或回调抛错都拒绝。组合器错误消息不原样泄露到错误响应。回调必须快速、纯同步，不能联网、写 selection 或递归调用编译器；任意宏解析、ST marker/override 语义由组合器策略负责。尚未展开的 `{{...}}` 会进入 DSH 的严格变量检查，建议使用包的 `/format` 中 `renderSillyTavernMacros` 或组合器自己的完整宏实现。

[可运行后端示例](examples/prompt-composer.mjs)展示固定段落策略、角色字段开关、开场适用性和 lore。它不是完整 ST PromptManager：不重建 marker 顺序、`{{original}}` override、真实 role/depth。插件作者可以直接替换 compose 策略，原始信息均保留。按例使用 `ctx.effect(() => registerComposer(...))`，保证卸载会释放注册。卸载前要继续使用当前会话，可先显式切回 builtin。

## 注入所有权与持久化

一次 assembly 只解析一次候选并调用一次组合器；同一 AssembleContext 缓存结果，随后 `agent/request` 使用该次快照参数，即便绑定在间隙变化也不混搭。下一次 assembly 会重新解析。默认 builtin 不受来源快照额外大小限制。

external 在 Tavern profile 的位置插入命名段落，保持宿主现有其他段落的相对顺序。默认 Tavern profile 正文不再产生；如有一次性导入上下文，该段仍承载导入内容。RP policy、工具 schema、runtime contexts、variables、真实历史、导入 claim/consume 生命周期继续由原负责人处理。**external 接管范围为角色/预设/用户/lore 及 Tavern sampler，不包括导入历史上下文或 Host persona。**已有 preset `systemPromptMode: replace` 在 external 下不再生效。

DSH 自身的 complete-section 或其他插件的 assembly override 仍可能覆盖这些段落；v3 不宣称能仲裁宿主全局替换。必须以实际模型请求/Trace 确认最终可见性。

偏好保存在 loader 数据目录 `prompt-composition.json`，只写 session→owner，不写资源正文；原子 rename，加载损坏文件会报错，不能默认为 builtin。注册函数在内存中，重启后插件必须重新注册相同 owner。缺失时读取 sources/mode 仍可用，生成拒绝；用户可 PUT builtin 恢复。新会话、fork、swipe 子会话和配置模板**不自动继承接管偏好**，即使资源绑定被复制也要单独启用。删除/卸载 Tavern 不改原生 DSH session/history。

v1 `/active` 继续提供内置策略预览，不能作为 external 的最终注入证据；external 实际系统正文由 DSH 请求及 Trace 的有效 system/message 验证。现有 Trace audit 增加 owner/sourceRevision/section 名称，不把原始 sources 快照持久化。

## 错误与恢复

统一 `{ ok: false, error: string, code?: string }`；保留既有 Host/安全层错误码。关键 v3 错误：

| 状态 / code | 处理 |
| --- | --- |
| 400 PROMPT_SESSION_INVALID / MODE_INVALID / COMPOSER_INVALID | 修正标识、对象字段或模式 |
| 404 PROMPT_NOT_FOUND | 检查 v3 路径；旧服务端不支持时只读降级，不擅自关闭 Tavern |
| 405 PROMPT_METHOD_NOT_ALLOWED | 使用支持的方法 |
| 409 PROMPT_REVISION_CONFLICT | 重新读 mode，重新确认应用意图 |
| 409 PROMPT_AGENT_RUNNING | 当前回合结束再切换 |
| 409 PROMPT_COMPOSER_CONFLICT / COMPOSER_UNAVAILABLE | 去重注册或恢复后端插件；也可显式切回 builtin |
| 409 PROMPT_RESOURCE_MISSING | 刷新/修复绑定，不将缺失资源当空卡 |
| 409 PROMPT_COMPOSER_LIMIT / SESSION_LIMIT | 清理多余注册/会话接管偏好 |
| 413 PROMPT_SOURCES_TOO_LARGE / OUTPUT_TOO_LARGE | 缩减选择或输出，不能假定部分字段已返回 |
| 422 PROMPT_OUTPUT_INVALID | 修复回调同步性、section 或采样格式 |
| 502 PROMPT_COMPOSER_FAILED | 查看组合器自己的安全诊断，修复后重新生成 |

HTTP body 使用既有 2048-byte 有界 JSON reader，非法 JSON/超限沿用 PLAY_INVALID_JSON / PLAY_REQUEST_TOO_LARGE。真实会话不存在/Host 不可用沿用 PLAY_SESSION_NOT_FOUND / PLAY_HOST_UNAVAILABLE 等 Host 错误。

## 验收

自动和人工验收清单见 [交付记录](PROMPT_API_V3_REVIEW.md)。本次不修改真实用户 profile、不使用真实角色卡或对话生成内容，不包含合并、tag 或 release；候选分支按用户授权提交并推送供审核。
