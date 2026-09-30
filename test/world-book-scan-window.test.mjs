// 世界书**扫描窗口**的本地默认（2026-09-30 用户拍板「改成扫最近两楼」）。
//
// 上游行为：书里没配 `scanDepth` ⇒ 扫**全部**消息 ⇒ 关键词只要出现过一次就此后每轮都命中
// （真机实测：70 条的书第 15 楼命中 43 条，只增不减）。
// 本地口径：未配 ⇒ **最近两楼**（一问一答 = 2 条消息 ⇒ 窗口 4 条）；书里显式配的值（含 0）照旧优先。
// ⚠️ 这是**本机本地改动、不是上游语义** —— 所以下面还钉了"非上游"标记那条 source pin。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWorldBookAdapter } from '../packages/tavern-loader/src/world-book-adapter.js'
import { parseWorldBook } from '../packages/world-book/src/index.js'

function book(settings) {
  const parsed = parseWorldBook({
    name: 'Scan window fixture',
    entries: {
      1: { uid: 1, key: ['OLDWORD'], content: 'old lore', position: 1 },
      2: { uid: 2, key: ['NEWWORD'], content: 'new lore', position: 1 },
    },
  })
  if (settings !== undefined) parsed.settings = settings
  return parsed
}

// OLDWORD 在最前面（窗口外），NEWWORD 在最新一条（窗口内）。窗口 = 最近 4 条 ⇒ 只有后 4 条被测。
const MESSAGES = [
  { text: 'OLDWORD 出现在很前面' },
  { text: 'filler-1' }, { text: 'filler-2' }, { text: 'filler-3' }, { text: 'filler-4' },
  { text: 'NEWWORD 就在最新这一条' },
]

function includedIds(settings) {
  const adapter = createWorldBookAdapter({ get: () => ({ id: 'book-a', name: 'A', book: book(settings) }) })
  const out = adapter.resolve({
    selection: { worldBookIds: ['book-a'] },
    activationContext: { messages: MESSAGES },
    character: null,
  })
  return (out.loreEntries ?? []).map(entry => entry.id).toSorted()
}

test('未配 scanDepth ⇒ 只扫最近两楼（4 条）：窗口外的词条不激活', () => {
  const ids = includedIds(undefined)
  assert.ok(ids.includes('book-a:2'), '最新那条里的词应当激活 —— 实得 ' + JSON.stringify(ids))
  assert.equal(ids.includes('book-a:1'), false, '窗口外的词不该激活 —— 实得 ' + JSON.stringify(ids))
})

test('★ 反证：书里显式配 scanDepth=6 ⇒ 同一条又进来了（证明是窗口把它挡掉的，且显式值优先）', () => {
  assert.deepEqual(includedIds({ scanDepth: 6 }), ['book-a:1', 'book-a:2'])
})

test('★ 反证：显式 scanDepth=0 ⇒ 一条都不扫（显式 0 不被默认值覆盖）', () => {
  assert.deepEqual(includedIds({ scanDepth: 0 }), [])
})

test('source pin：这处本地改动必须带「非上游」标记与那常量', () => {
  const src = readFileSync(new URL('../packages/tavern-loader/src/world-book-adapter.js', import.meta.url), 'utf8')
  assert.match(src, /LOCAL_DEFAULT_SCAN_DEPTH_MESSAGES = 4/)
  assert.match(src, /本机本地改动（\*\*非上游\*\*）/)
})
