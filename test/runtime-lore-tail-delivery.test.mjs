// 尾部世界书条目（runtime lore tail delivery）的交付计划 —— 钉住「换掉而不是叠加」。
//
// 背景（2026-09-30 真机实测）：旧写法每轮 `messages: [...messages, 新条目]` 只加不减，
// 而上一条已作为 `user/message` 落盘成历史 ⇒ 10 楼之后请求里叠了 **10 份**，每份 21,623 字，
// 光这一项占请求体 **79.5%**。修法 = 用宿主的 surface 替换（compaction 压历史同款）：
// 新节点占旧节点的位置，旧的从**请求面**消失（日志仍保留）。
//
// ⛔ 判据不是"函数返回了个对象"，而是：**记着上一轮且那条还在 surface 上时，必须 replace**。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { planRuntimeLoreSurfaceOp } from '../packages/tavern-loader/src/index.js'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/tavern-loader/src/index.js'),
  'utf8',
)

test('first delivery has nothing to replace: plain append, and no sourceEventSeqs', () => {
  const intent = planRuntimeLoreSurfaceOp({ previousSeq: undefined, surfaceNodes: [3, 7, 9] })
  assert.equal(intent.surfaceOp, 'append')
  assert.equal(Object.hasOwn(intent, 'sourceEventSeqs'), false)
})

test('the previous turn\'s node is still on the surface: replace exactly it', () => {
  const intent = planRuntimeLoreSurfaceOp({ previousSeq: 7, surfaceNodes: [3, 7, 9] })
  assert.deepEqual(intent, {
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  })
})

test('★ the replaced node must itself cite the shadowed node (host contract)', () => {
  const intent = planRuntimeLoreSurfaceOp({ previousSeq: 7, surfaceNodes: [3, 7, 9] })
  assert.deepEqual(intent.sourceEventSeqs, [intent.surfaceOp.startSeq])
})

test('a node compacted away is no longer replaceable: fall back to append', () => {
  // 被压缩掉 ⇒ 7 已不在 surface 上；拿它去 replace 会被宿主拒掉，必须退回 append。
  const intent = planRuntimeLoreSurfaceOp({ previousSeq: 7, surfaceNodes: [11, 12] })
  assert.equal(intent.surfaceOp, 'append')
})

test('malformed input never fabricates a replace', () => {
  for (const input of [
    {},
    { previousSeq: 7 },
    { previousSeq: 7.5, surfaceNodes: [7] },
    { previousSeq: 7, surfaceNodes: null },
    { previousSeq: null, surfaceNodes: [7] },
  ]) {
    assert.equal(planRuntimeLoreSurfaceOp(input).surfaceOp, 'append', JSON.stringify(input))
  }
})

test('★ counter-proof: the tail delivery must go through session.append + replace', () => {
  // 这条是 source pin：只要有人把注入退回"每轮往 decision.messages 追加"的老写法
  // （= 累积的根因），下面任一断言必红。
  assert.match(SOURCE, /session\.append\('user\/message', message, planRuntimeLoreSurfaceOp\(/)
  assert.match(SOURCE, /surfaceOp: \{ op: 'replace', startSeq: previousSeq, endSeq: previousSeq \}/)
  assert.match(SOURCE, /const tailLoreSeqBySession = new Map\(\)/)
})
