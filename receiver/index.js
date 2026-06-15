#!/usr/bin/env node
/**
 * CoRead 本地接收端
 * 监听来自 Chrome 扩展的标注、正文、章节事件，写入本地文件。
 * 启动：node receiver/index.js
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.COREAD_PORT || '7239')
const BOOKS_DIR = path.join(__dirname, 'books')
const INBOX_DIR = path.join(__dirname, 'inbox')
const CHAT_OUTPUT = path.join(INBOX_DIR, 'chat_output.jsonl')
const DEBUG_LOG = path.join(INBOX_DIR, 'debug.jsonl')

fs.mkdirSync(BOOKS_DIR, { recursive: true })
fs.mkdirSync(INBOX_DIR, { recursive: true })

// ── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set()

// 内存缓冲：新客户端连上时回放最近 2 分钟的事件
const recentEvents = []
const REPLAY_WINDOW_MS = 120_000

function pushSSE(type, data) {
  const event = { type, ...data, _ts: Date.now() }
  recentEvents.push(event)
  if (recentEvents.length > 50) recentEvents.shift()
  if (sseClients.size === 0) return
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`
  for (const client of sseClients) {
    try { client.write(payload) } catch { sseClients.delete(client) }
  }
}

// 初始化 chat_output 游标（跳过已有内容，只推送新消息）
let chatOutputLastLine = (() => {
  try { return fs.readFileSync(CHAT_OUTPUT, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 }
})()

// 每秒轮询 chat_output.jsonl，有新行就推送给所有 SSE 客户端
setInterval(() => {
  if (sseClients.size === 0) return
  try {
    const lines = fs.readFileSync(CHAT_OUTPUT, 'utf8').trim().split('\n').filter(Boolean)
    if (lines.length <= chatOutputLastLine) return
    for (const line of lines.slice(chatOutputLastLine)) {
      try { pushSSE('message', JSON.parse(line)) } catch {}
    }
    chatOutputLastLine = lines.length
  } catch {}
}, 1000)

function bookDir(bookId) {
  const d = path.join(BOOKS_DIR, bookId)
  fs.mkdirSync(path.join(d, 'chapters'), { recursive: true })
  return d
}

function baseBookId(bookId) {
  return String(bookId || '').replace(/k[0-9a-f]{24,}$/i, '')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body)) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '')
}

function looksWereadEncoded(text) {
  return /^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]{100,}$/.test(String(text || '').trim())
}

function cjkCount(text) {
  return (String(text || '').match(/[\u4e00-\u9fff]/g) || []).length
}

function triggerInject(message) {
  const pendingFile = path.join(INBOX_DIR, 'pending.txt')
  fs.appendFileSync(pendingFile, message + '\n')
  const injectScript = path.join(__dirname, '..', 'agent', 'scripts', 'inject.sh')
  if (fs.existsSync(injectScript)) {
    try { execSync(`bash "${injectScript}"`, { timeout: 5000 }) }
    catch (e) { /* inject 失败不影响接收端运行 */ }
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  // OPTIONS 预检直接放行
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // 历史记录（GET /history）
  if (req.method === 'GET' && req.url === '/history') {
    const items = []
    const readJsonl = (file) => {
      try {
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      } catch { return [] }
    }
    for (const d of readJsonl(path.join(INBOX_DIR, 'annotations.jsonl'))) {
      items.push({ role: 'annotation', content: `《${d.bookTitle}》${d.chapter || ''}`,
        selectedText: d.selectedText, userNote: d.userNote || '',
        _ts: d.receivedAt || d.timestamp * 1000 })
    }
    for (const d of readJsonl(path.join(INBOX_DIR, 'chat_input.jsonl'))) {
      items.push({ role: 'user', content: d.content, _ts: d.timestamp })
    }
    for (const d of readJsonl(CHAT_OUTPUT)) {
      items.push({ role: 'assistant', content: d.content, _ts: d.timestamp || 0 })
    }
    items.sort((a, b) => a._ts - b._ts)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(items.slice(-100)))
    return
  }

  // SSE 订阅（GET /events）
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
    // 回放最近 2 分钟的事件，避免 sidebar 打开时错过已发送的标注
    const cutoff = Date.now() - REPLAY_WINDOW_MS
    for (const evt of recentEvents) {
      if (evt._ts >= cutoff) {
        const { _ts, ...rest } = evt
        res.write(`data: ${JSON.stringify(rest)}\n\n`)
      }
    }
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // POST 只允许 weread.qq.com 和 扩展 sidebar（chrome-extension://）
  if (req.method === 'POST' && origin
    && !origin.includes('weread.qq.com')
    && !origin.startsWith('chrome-extension://')) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

  let data
  try { data = await readBody(req) }
  catch { res.writeHead(400); res.end('Bad JSON'); return }

  const url = req.url

  try {
    if (url === '/annotation') {
      // 标注写入 inbox
      const line = JSON.stringify({ ...data, receivedAt: Date.now() })
      fs.appendFileSync(path.join(INBOX_DIR, 'annotations.jsonl'), line + '\n')
      console.log(`[annotation] ${data.bookTitle} · ${data.chapter} · "${data.selectedText?.slice(0, 20)}..."`)
      triggerInject(`【新划线】《${data.bookTitle}》${data.chapter}`)
      // 推送标注事件到侧栏（含用户批注）
      pushSSE('message', {
        role: 'annotation',
        content: `《${data.bookTitle}》${data.chapter || ''}`,
        selectedText: data.selectedText,
        userNote: data.userNote || '',
      })

    } else if (url === '/chat') {
      // 来自侧栏的用户消息
      const { content } = data
      if (!content) { res.writeHead(400); res.end(); return }
      fs.appendFileSync(path.join(INBOX_DIR, 'chat_input.jsonl'),
        JSON.stringify({ role: 'user', content, timestamp: Date.now() }) + '\n')
      console.log(`[chat] ${content.slice(0, 50)}`)

    } else if (url === '/content') {
      // 章节正文缓存
      const { bookId, chapterUid, text, selectedText } = data
      if (!bookId || !chapterUid || !text) {
        console.warn(`[content] 400 missing fields: bookId=${bookId} chapterUid=${chapterUid} textLen=${text?.length}`)
        res.writeHead(400); res.end(); return
      }
      const chapterFile = path.join(bookDir(bookId), 'chapters', `${chapterUid}.txt`)
      const existing = readIfExists(chapterFile)
      if (existing && existing.length > text.length) {
        if (looksWereadEncoded(existing) && cjkCount(text) > 50) {
          fs.writeFileSync(chapterFile, text)
          console.log(`[content] replaced encoded bookId=${bookId} chapterUid=${chapterUid} (${text.length} chars)`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, replacedEncoded: true }))
          return
        }
        const existingHasSelection = selectedText && normalizeText(existing).includes(normalizeText(selectedText))
        const textHasSelection = selectedText && normalizeText(text).includes(normalizeText(selectedText))
        if (selectedText && (existingHasSelection || !textHasSelection)) {
          console.log(`[content] kept existing bookId=${bookId} chapterUid=${chapterUid} (${existing.length} chars)`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, keptExisting: true }))
          return
        }
      }
      fs.writeFileSync(chapterFile, text)
      console.log(`[content] bookId=${bookId} chapterUid=${chapterUid} (${text.length} chars)`)

    } else if (url === '/debug') {
      const line = JSON.stringify({ ...data, receivedAt: Date.now() })
      fs.appendFileSync(DEBUG_LOG, line + '\n')
      console.log(`[debug] ${data.source || 'unknown'} ${data.stage || ''} ${data.bookTitle || data.bookId || ''}`)

    } else if (url === '/chapter-complete') {
      // 章节结束事件
      const { bookId, chapterUid, chapterTitle, bookTitle } = data
      console.log(`[chapter-complete] 《${bookTitle}》${chapterTitle}`)
      // 更新进度
      const progressFile = path.join(bookDir(bookId), 'progress.json')
      const prev = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile)) : {}
      fs.writeFileSync(progressFile, JSON.stringify({ ...prev, lastChapterUid: chapterUid, updatedAt: Date.now() }))
      const msg = `【章节完成】《${bookTitle}》${chapterTitle} 已读完，请生成本章摘要并问我这章的 learning。`
      triggerInject(msg)

    } else if (url === '/progress') {
      // 进度同步（来自 weread API 兜底轮询，后期用）
      const { bookId } = data
      if (bookId) {
        const payload = JSON.stringify({ ...data, updatedAt: Date.now() })
        fs.writeFileSync(path.join(bookDir(bookId), 'progress.json'), payload)
        const baseId = baseBookId(bookId)
        if (baseId && baseId !== bookId) {
          fs.writeFileSync(path.join(bookDir(baseId), 'progress.json'), payload)
        }
      }

    } else {
      res.writeHead(404); res.end(); return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (e) {
    console.error('[error]', e)
    res.writeHead(500)
    res.end(e.message)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CoRead receiver listening on http://localhost:${PORT}`)
  console.log(`Inbox: ${INBOX_DIR}`)
  console.log(`Books: ${BOOKS_DIR}`)
})
