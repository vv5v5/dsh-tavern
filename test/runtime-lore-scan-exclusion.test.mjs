// 世界书触发面**不许包含我们自己注入的那条**（2026-09-30 真机 bug）。
//
// 症状：尾部交付的世界书是一条 `user` 消息，里面装的就是**词条正文本身**；它又落进
// `activationContext` 的扫描面 ⇒ 上一轮激活的词条靠**自己正文里的关键词**把自己重新激活
// ⇒ 一旦激活就下不来（实测 entries 连着好几轮恒定 5 = 自锁集合，而不是"当前相关"）。
//
// 判据：`activationContext().text` 里**只有真实对话**；把我们那条（`source.form === 'runtime-lore'`）排除。
// ★ 反证：换掉 `form`（不再是 runtime-lore）⇒ 同一条**必须**重新出现在扫描面里 —— 证明"消失"确实是那条判据干的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingInputProjection } from '../packages/tavern-loader/src/pending-input-projection.js'

const PLAYER = { id: 'p1', role: 'user', content: [{ type: 'text', text: '幻蕊站在门口。' }], source: { kind: 'user' } }
const LORE = (form) => ({
  id: 'l1', role: 'user',
  content: [{ type: 'text', text: '〔世界书 · book-a〕炼核与研核的产能说明。' }],
  source: { kind: 'plugin:pmp-dsh-tavern', form },
})
const agentWith = (...messages) => ({
  id: 'sess-1',
  session: { id: 'sess-1', deriveMessages: () => messages, snapshotEvents: () => [], surface: { nodes: [] } },
})

const scan = (form) => new PendingInputProjection({}).activationContext(agentWith(PLAYER, LORE(form)))

test('our own world-book delivery is NOT in the scan text', () => {
  const ctx = scan('runtime-lore')
  assert.ok(ctx.text.includes('幻蕊'), '真实对话必须还在：' + ctx.text.slice(0, 80))
  assert.equal(ctx.text.includes('炼核'), false, '自己的注入不该进扫描面（否则自触发）')
})

test('★ counter-proof: the same message WITH another form IS scanned', () => {
  const ctx = scan('some-other-form')
  assert.ok(ctx.text.includes('炼核'), '换掉 form 就该照常参与（证明判据咬在 form 上）')
})

test('the skip is reported honestly, not as truncation', () => {
  const ctx = scan('runtime-lore')
  assert.equal(ctx.metadata.skippedWorldBookMessageCount, 1)
  assert.equal(ctx.metadata.truncated, false, '有意不扫 ≠ 截断')
})
