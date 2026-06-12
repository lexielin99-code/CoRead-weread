#!/usr/bin/env node
/**
 * CoRead 共读 agent — 自包含交互式会话
 *
 * 在 tmux 里常驻运行，读取标准输入（用户输入 + inject.sh 注入的触发行），
 * 与用户实时讨论标注，调用 LLM API 生成回应。不依赖任何外部 CLI。
 *
 * 启动：
 *   cp .env.example .env  # 填入 COREAD_API_KEY 等配置
 *   npm start
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENT_DIR = __dirname
const RECEIVER_DIR = path.join(__dirname, '..', 'receiver')
const INBOX_DIR = path.join(RECEIVER_DIR, 'inbox')
const BOOKS_DIR = path.join(RECEIVER_DIR, 'books')
const ANNOTATIONS = path.join(INBOX_DIR, 'annotations.jsonl')
const CURSOR_FILE = path.join(INBOX_DIR, '.agent_cursor')
const CHAT_INPUT = path.join(INBOX_DIR, 'chat_input.jsonl')
const CHAT_INPUT_CURSOR = path.join(INBOX_DIR, '.chat_input_cursor')
const CHAT_OUTPUT = path.join(INBOX_DIR, 'chat_output.jsonl')

const API_KEY = process.env.COREAD_API_KEY
const API_BASE = (process.env.COREAD_API_BASE || '').replace(/\/$/, '')
const MODEL = process.env.COREAD_MODEL || 'gpt-4o'

if (!API_KEY) {
  console.error('❌ 请设置 COREAD_API_KEY 环境变量')
  process.exit(1)
}
if (!API_BASE) {
  console.error('❌ 请设置 COREAD_API_BASE 环境变量（如 https://api.openai.com/v1）')
  process.exit(1)
}

// ── 文件读取 ────────────────────────────────────────────────────────────────
function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

// ── 上下文加载（启动时一次性构建） ──────────────────────────────────────────
function buildSystemInstruction() {
  const rules = readIfExists(path.join(AGENT_DIR, 'AGENT.md'))
  const profile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  const soul = readIfExists(path.join(AGENT_DIR, 'soul.md'))
  const openTopics = readIfExists(path.join(AGENT_DIR, 'open_topics.md'))
  return [
    '【重要】所有必要数据已直接包含在对话内容里，不需要也不允许调用任何工具或函数。直接用中文回答。\n\n',
    rules,
    '\n\n========\n# 用户阅读画像（profile.md）\n', profile,
    '\n\n========\n# 你的自画像（soul.md）\n', soul,
    '\n\n========\n# 未明话题（open_topics.md）\n', openTopics,
  ].join('')
}

// ── 侧栏聊天 I/O ─────────────────────────────────────────────────────────────
function appendChatOutput(role, content) {
  try { fs.appendFileSync(CHAT_OUTPUT, JSON.stringify({ role, content, timestamp: Date.now() }) + '\n') } catch {}
}

function readChatInputs() {
  const raw = readIfExists(CHAT_INPUT)
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

function getChatInputCursor() {
  const v = parseInt(readIfExists(CHAT_INPUT_CURSOR), 10)
  return Number.isFinite(v) ? v : 0
}

function setChatInputCursor(n) { fs.writeFileSync(CHAT_INPUT_CURSOR, String(n)) }

// ── 标注队列 ────────────────────────────────────────────────────────────────
function readAnnotations() {
  const raw = readIfExists(ANNOTATIONS)
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

function getCursor() {
  const v = parseInt(readIfExists(CURSOR_FILE), 10)
  return Number.isFinite(v) ? v : 0
}

function setCursor(n) { fs.writeFileSync(CURSOR_FILE, String(n)) }

// ── 章节原文上下文 ───────────────────────────────────────────────────────────
function chapterWindow(bookId, chapterUid, selectedText) {
  if (!bookId || !chapterUid) return ''
  const file = path.join(BOOKS_DIR, bookId, 'chapters', `${chapterUid}.txt`)
  const text = readIfExists(file)
  if (!text) return ''
  const idx = text.indexOf(selectedText)
  if (idx === -1) return text.slice(0, 600)
  const start = Math.max(0, idx - 300)
  const end = Math.min(text.length, idx + selectedText.length + 300)
  return text.slice(start, end)
}

function bookSummaries(bookId) {
  if (!bookId) return ''
  return readIfExists(path.join(BOOKS_DIR, bookId, 'summaries.md'))
}

// ── LLM API ──────────────────────────────────────────────────────────────────
let SYSTEM = buildSystemInstruction()
const history = []  // [{ role: 'user'|'assistant', content: string }]

async function callLLM() {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      max_tokens: 1024,
      tool_choice: 'none',
    }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  const msg = data.choices?.[0]?.message
  const text = msg?.content || msg?.reasoning_content
  if (!text) throw new Error('模型无回应：' + JSON.stringify(data).slice(0, 200))
  // 剥掉模型可能输出的代码块（不该出现，但兜底）
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/^\s*\n/gm, '\n').trim()
  return stripped
}

async function say(userText) {
  history.push({ role: 'user', content: userText })
  let reply
  try {
    reply = await callLLM()
  } catch (e) {
    history.pop()
    return `⚠️ ${e.message}`
  }
  history.push({ role: 'assistant', content: reply })
  return reply
}

// ── 持久化 ───────────────────────────────────────────────────────────────────
function ensureBookDir(bookId) {
  const d = path.join(BOOKS_DIR, bookId)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function saveTakeaway(ann, takeaway) {
  if (!ann?.bookId || !takeaway) return
  const line = JSON.stringify({
    bookId: ann.bookId,
    bookTitle: ann.bookTitle,
    chapter: ann.chapter || '',
    selectedText: ann.selectedText,
    takeaway,
    timestamp: Math.floor(Date.now() / 1000),
  })
  fs.appendFileSync(path.join(ensureBookDir(ann.bookId), 'discussions.jsonl'), line + '\n')
}

// 在第 N 轮时把 takeaway 请求附在用户消息末尾，从模型回应里解析出来
function extractTakeaway(reply) {
  const match = reply.match(/【TAKEAWAY】(.+)/)
  return match ? match[1].trim() : null
}

// 会话结束时合并重写 profile / soul，保持文件精简不膨胀
async function saveSessionMemory() {
  if (history.length < 4) return
  console.log('\n正在固化本次会话记忆...')

  const currentProfile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  const currentSoul = readIfExists(path.join(AGENT_DIR, 'soul.md'))

  const prompt = `会话即将结束。请将原内容与本次讨论的新认知合并，输出完整的重写版本（删去被覆盖的旧条目，保持精简）：

【PROFILE_REWRITE】
（合并后的完整 profile.md，≤400字；无新认知则原样输出）
原内容：
${currentProfile}

【SOUL_REWRITE】
（合并后的完整 soul.md，≤250字；无变化则原样输出）
原内容：
${currentSoul}`

  const resp = await say(prompt)

  const profileMatch = resp.match(/【PROFILE_REWRITE】\n?([\s\S]+?)(?=【SOUL_REWRITE】)/)
  const soulMatch = resp.match(/【SOUL_REWRITE】\n?([\s\S]+)$/)

  if (profileMatch?.[1]?.trim()) {
    fs.writeFileSync(path.join(AGENT_DIR, 'profile.md'), profileMatch[1].trim() + '\n')
    console.log('  ✓ profile.md 已合并重写')
  }
  if (soulMatch?.[1]?.trim()) {
    fs.writeFileSync(path.join(AGENT_DIR, 'soul.md'), soulMatch[1].trim() + '\n')
    console.log('  ✓ soul.md 已合并重写')
  }
}

// ── 跨书记忆检索 ─────────────────────────────────────────────────────────────
function runRecall(selectedText) {
  try {
    const query = selectedText.slice(0, 40).replace(/["'\n]/g, ' ').trim()
    const script = path.join(AGENT_DIR, 'scripts', 'recall.js')
    const result = execSync(`node "${script}" "${query}"`, { timeout: 5000, encoding: 'utf8' }).trim()
    if (result && !result.startsWith('无')) return result
  } catch {}
  return ''
}

// ── 标注 prompt 构建 ─────────────────────────────────────────────────────────
function buildAnnotationPrompt(ann, turnHint = '') {
  const { bookTitle, chapter, selectedText, userNote, bookId, chapterUid } = ann
  let p = `【新划线】《${bookTitle}》${chapter || ''}\n选中文字："${selectedText}"\n`

  if (userNote) {
    p += `\n用户的第一反应："${userNote}"\n`
  }

  const recall = runRecall(selectedText)
  if (recall) p += `\n[阅读记忆检索]\n${recall}\n`

  const win = chapterWindow(bookId, chapterUid, selectedText)
  if (win) {
    p += `\n[这段话所在的原文上下文]\n${win}\n`
  } else {
    p += `\n（暂无这本书的原文足迹。如果作者在后文对这个问题有新的回应，我们到时再一起讨论。）\n`
  }

  const sum = bookSummaries(bookId)
  if (sum) p += `\n[本书已读章节摘要]\n${sum}\n`

  p += `\n请按行为规则开始讨论这条划线。`
  if (turnHint) p += turnHint
  return p
}

// ── 首次启动：引导冷启动 ─────────────────────────────────────────────────────
const COLDSTART_SKIP_FLAG = path.join(AGENT_DIR, '.coldstart_skipped')

function hasRealProfile() {
  const profile = readIfExists(path.join(AGENT_DIR, 'profile.md'))
  // 有超过 200 字的真实内容（排除空模板和只有日期的情况）
  return profile.replace(/[-\s_*#]/g, '').length > 200
}

function askQuestion(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

async function maybeRunColdstart(rl) {
  if (hasRealProfile()) return            // 已有画像，跳过
  if (fs.existsSync(COLDSTART_SKIP_FLAG)) return  // 用户之前选了跳过

  console.log('👋 检测到尚未建立阅读画像。')
  console.log('   CoRead 可以通过你的微信读书历史（书架、划线、想法）')
  console.log('   生成一份初始了解，让后续讨论更有针对性。\n')

  const answer = await askQuestion(rl, '是否现在加载？需要 WEREAD_API_KEY（y/n）: ')

  if (answer.trim().toLowerCase() !== 'y') {
    fs.writeFileSync(COLDSTART_SKIP_FLAG, '')
    console.log('\n（已跳过，如需加载可手动运行 node scripts/coldstart.js）\n')
    return
  }

  if (!process.env.WEREAD_API_KEY) {
    console.log('\n⚠️  未检测到 WEREAD_API_KEY，请在 .env 里添加后重新启动。\n')
    return
  }

  console.log('\n开始加载微信读书历史...\n')
  const { execSync } = await import('child_process')
  try {
    execSync(`node "${path.join(AGENT_DIR, 'scripts', 'coldstart.js')}"`, {
      stdio: 'inherit',
      env: process.env,
    })
    // coldstart 成功后重建系统指令
    SYSTEM = buildSystemInstruction()
    console.log('\n✓ 阅读画像已加载，开始共读。\n')
  } catch (e) {
    console.log(`\n⚠️  加载失败：${e.message}\n`)
  }
}

// ── 处理新标注 ───────────────────────────────────────────────────────────────
let currentAnn = null
let annTurnCount = 0

async function processNewAnnotations() {
  const anns = readAnnotations()
  const cursor = getCursor()
  if (cursor >= anns.length) return false

  for (let i = cursor; i < anns.length; i++) {
    const ann = anns[i]
    currentAnn = ann
    annTurnCount = 0
    console.log(`\n── 新划线 · 《${ann.bookTitle}》${ann.chapter || ''} ──`)
    const reply = await say(buildAnnotationPrompt(ann))
    console.log('\n' + reply + '\n')
    appendChatOutput('assistant', reply)
  }
  setCursor(anns.length)
  return true
}

// ── REPL ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('📖 CoRead 共读 agent 已启动')
  console.log(`   监听标注：${ANNOTATIONS}`)
  console.log('   输入 /exit 退出，/topics 看未明话题\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })

  // 首次启动引导
  await maybeRunColdstart(rl)

  const had = await processNewAnnotations()
  if (!had) console.log('（暂无新标注。开始阅读后划线，我会接话。）\n')

  rl.prompt()

  let busy = false

  // 每 3 秒轮询新标注 + 侧栏用户消息
  const poller = setInterval(async () => {
    if (busy) return

    // 优先处理新标注
    const anns = readAnnotations()
    if (getCursor() < anns.length) {
      busy = true
      rl.pause()
      try { await processNewAnnotations() } catch (e) { console.log(`⚠️ ${e.message}\n`) }
      busy = false
      rl.resume()
      rl.prompt()
      return
    }

    // 处理来自侧栏的用户消息
    const inputs = readChatInputs()
    const chatCursor = getChatInputCursor()
    if (chatCursor >= inputs.length) return
    busy = true
    rl.pause()
    try {
      for (let i = chatCursor; i < inputs.length; i++) {
        const msg = inputs[i]
        annTurnCount++
        let userMsg = msg.content
        if (annTurnCount >= 3 && currentAnn) {
          userMsg += '\n\n（请在这轮回应结尾加一行：【TAKEAWAY】你的一句收口总结，15-30字）'
        }
        const reply = await say(userMsg)
        const takeaway = extractTakeaway(reply)
        if (takeaway && currentAnn) { saveTakeaway(currentAnn, takeaway) }
        console.log('\n[侧栏] ' + reply + '\n')
        appendChatOutput('assistant', reply)
      }
      setChatInputCursor(inputs.length)
    } catch (e) { console.log(`⚠️ ${e.message}\n`) }
    busy = false
    rl.resume()
    rl.prompt()
  }, 3000)

  rl.on('line', async (raw) => {
    const line = raw.trim()
    if (!line) { rl.prompt(); return }
    if (busy) return

    if (line === '/exit' || line === '/quit') { rl.close(); return }
    if (line === '/topics') {
      console.log('\n' + readIfExists(path.join(AGENT_DIR, 'open_topics.md')) + '\n')
      rl.prompt(); return
    }

    busy = true
    rl.pause()
    try {
      if (line.startsWith('【新划线】')) {
        await processNewAnnotations()
      } else if (line.startsWith('【章节完成】')) {
        const reply = await say(line)
        console.log('\n' + reply + '\n')
        appendChatOutput('assistant', reply)
      } else {
        // 普通用户回复：追踪轮次，第 3 轮起附 takeaway 请求
        annTurnCount++
        let userMsg = line
        if (annTurnCount >= 3 && currentAnn) {
          userMsg += '\n\n（请在这轮回应结尾加一行：【TAKEAWAY】你的一句收口总结，15-30字）'
        }
        const reply = await say(userMsg)

        const takeaway = extractTakeaway(reply)
        if (takeaway && currentAnn) {
          saveTakeaway(currentAnn, takeaway)
          console.log(`\n  [takeaway 已保存]\n`)
        }

        console.log('\n' + reply + '\n')
        appendChatOutput('assistant', reply)
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}\n`)
    }
    busy = false
    rl.resume()
    rl.prompt()
  })

  rl.on('close', async () => {
    clearInterval(poller)
    try { await saveSessionMemory() } catch (e) { console.log(`⚠️ 记忆固化失败: ${e.message}`) }
    console.log('👋 共读会话结束。')
    process.exit(0)
  })
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
