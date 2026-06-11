#!/usr/bin/env node
/**
 * scripts/recall.js <查询文字>
 * 在所有书的 discussions.jsonl 里检索相关 takeaway，输出最多 3 条。
 * 供 agent 在讨论新标注前调用，做跨书记忆检索。
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BOOKS_DIR = path.join(__dirname, '../../receiver/books')
const query = process.argv.slice(2).join(' ').trim()

if (!query) {
  console.log('用法: node scripts/recall.js <关键词或原文片段>')
  process.exit(0)
}

const keywords = query.toLowerCase().split(/[\s，。？！、""''《》]+/).filter(w => w.length >= 2)

if (!fs.existsSync(BOOKS_DIR)) {
  console.log('无阅读记录')
  process.exit(0)
}

const results = []

for (const bookId of fs.readdirSync(BOOKS_DIR)) {
  const file = path.join(BOOKS_DIR, bookId, 'discussions.jsonl')
  if (!fs.existsSync(file)) continue

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const d = JSON.parse(line)
      const text = (d.takeaway || '').toLowerCase()
      if (!text) continue
      const score = keywords.filter(k => text.includes(k)).length
      if (score > 0) results.push({ ...d, score })
    } catch {}
  }
}

results.sort((a, b) => b.score - a.score)
const top = results.slice(0, 3)

if (top.length === 0) {
  console.log('无相关历史记录')
} else {
  console.log('【阅读记忆】')
  for (const r of top) {
    const book = r.bookTitle || r.bookId || '未知书目'
    const chapter = r.chapter ? `·${r.chapter}` : ''
    console.log(`《${book}》${chapter}：${r.takeaway}`)
  }
}
