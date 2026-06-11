#!/usr/bin/env node
/**
 * CoRead 冷启动脚本
 * 用途：通过 weread API 全量拉取书架、划线、想法，生成 profile.md 阅读画像初稿。
 *
 * 使用：
 *   export WEREAD_API_KEY=wrk-xxxxxxxx
 *   export GEMINI_API_KEY=AIza-xxxxxxxx
 *   node agent/scripts/coldstart.js
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = path.join(__dirname, '..')
const SKILL_VERSION = '1.0.3'
const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway'

const WEREAD_KEY = process.env.WEREAD_API_KEY
const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'

if (!WEREAD_KEY) {
  console.error('❌ 请设置 WEREAD_API_KEY 环境变量')
  process.exit(1)
}
if (!API_KEY) {
  console.error('❌ 请设置 COREAD_API_KEY 环境变量')
  process.exit(1)
}
if (!API_BASE) {
  console.error('❌ 请设置 COREAD_API_BASE 环境变量（如 https://api.openai.com/v1）')
  process.exit(1)
}

// ── weread API 调用封装 ────────────────────────────────────────────────────
async function wereadCall(params) {
  const body = { ...params, skill_version: SKILL_VERSION }
  const resp = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WEREAD_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await resp.json()
  if (data.upgrade_info) {
    console.error('⚠️  weread skill 需要升级：', data.upgrade_info.message)
    process.exit(1)
  }
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`weread API error: ${data.errmsg || JSON.stringify(data)}`)
  }
  return data
}

// ── 1. 拉取书架 ────────────────────────────────────────────────────────────
async function fetchShelf() {
  console.log('📚 拉取书架...')
  const data = await wereadCall({ api_name: '/shelf/sync' })
  return data.books || []
}

// ── 2. 拉取全量笔记本列表（所有有划线的书） ──────────────────────────────
async function fetchAllNotebooks() {
  console.log('📝 拉取笔记本列表...')
  const books = []
  let lastSort = undefined
  while (true) {
    const params = { api_name: '/user/notebooks', count: 100 }
    if (lastSort !== undefined) params.lastSort = lastSort
    const data = await wereadCall(params)
    if (data.books) books.push(...data.books)
    if (!data.hasMore) break
    lastSort = data.books[data.books.length - 1]?.sort
    await new Promise(r => setTimeout(r, 200))
  }
  console.log(`  → ${books.length} 本书有笔记`)
  return books
}

// ── 3. 拉取某本书的划线 ────────────────────────────────────────────────────
async function fetchBookmarks(bookId) {
  try {
    const data = await wereadCall({ api_name: '/book/bookmarklist', bookId })
    return data.updated || []
  } catch {
    return []
  }
}

// ── 4. 拉取某本书的想法 ────────────────────────────────────────────────────
async function fetchReviews(bookId) {
  const reviews = []
  let synckey = 0
  while (true) {
    const data = await wereadCall({ api_name: '/review/list/mine', bookid: bookId, count: 100, synckey })
    if (data.reviews) reviews.push(...data.reviews)
    if (!data.hasMore) break
    synckey = data.synckey
    await new Promise(r => setTimeout(r, 200))
  }
  return reviews
}

// ── 5. 用 LLM API 蒸馏阅读画像 ──────────────────────────────────────────────
async function distillProfile(shelfBooks, notebookBooks, sampleHighlights) {
  console.log('🤖 正在蒸馏阅读画像...')

  const shelfSummary = shelfBooks.slice(0, 50).map(b =>
    `- 《${b.title}》${b.author || ''}`
  ).join('\n')

  const notesSummary = notebookBooks.slice(0, 30).map(b =>
    `- 《${b.book?.title || b.bookId}》 划线${b.noteCount}条 想法${b.reviewCount}条 进度${b.readingProgress || 0}%`
  ).join('\n')

  const highlightsSample = sampleHighlights.slice(0, 80).map(h =>
    `[${h.bookTitle}] "${h.markText}"`
  ).join('\n')

  const prompt = `你是一个阅读画像分析师。基于以下用户的微信读书数据，生成一份精准的阅读画像。

## 书架（最多50本）
${shelfSummary}

## 有笔记的书（按笔记数排序，最多30本）
${notesSummary}

## 划线样本（最多80条）
${highlightsSample}

请生成以下格式的 Markdown 文档（约300-400字，精准具体，不要废话）：

# 用户阅读画像

## 关注主题
（列出3-5个核心关注领域，具体而非泛泛）

## 阅读品味
（什么类型的书/写作风格特别感兴趣，什么不读）

## 思维习惯
（从划线内容推断：偏爱什么类型的论证/观点，对什么感到着迷）

## 对话偏好
（根据内容特征推断：喜欢直接还是迂回，倾向具体例子还是抽象原则）

## 书架概览
（列出在读 + 读过的代表性书目，附简短说明）`

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  })
  const data = await resp.json()
  return data.choices?.[0]?.message?.content || ''
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 CoRead 冷启动开始\n')

  const shelf = await fetchShelf()
  console.log(`  书架共 ${shelf.length} 本书\n`)

  const notebooks = await fetchAllNotebooks()

  // 按笔记数排序，拉取 top 20 本书的划线
  const topBooks = notebooks
    .sort((a, b) => (b.noteCount + b.reviewCount) - (a.noteCount + a.reviewCount))
    .slice(0, 20)

  console.log('\n📖 拉取 top 20 本书的划线样本...')
  const allHighlights = []
  for (const nb of topBooks) {
    const bookId = nb.bookId
    const title = nb.book?.title || bookId
    const marks = await fetchBookmarks(bookId)
    marks.forEach(m => allHighlights.push({ bookTitle: title, markText: m.markText }))
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 150))
  }
  console.log(`\n  → 共 ${allHighlights.length} 条划线样本\n`)

  const profileContent = await distillProfile(shelf, notebooks, allHighlights)

  const profilePath = path.join(AGENT_DIR, 'profile.md')
  fs.writeFileSync(profilePath, profileContent + `\n\n---\n_冷启动于 ${new Date().toISOString().slice(0,10)}_\n`)

  console.log('\n✅ profile.md 已生成：', profilePath)
  console.log('\n冷启动完成！现在可以打开 agent/ 目录开始共读会话了。\n')
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
