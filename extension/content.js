/**
 * CoRead content script — 运行于 weread.qq.com/web/reader/*
 */

const RECEIVER = 'http://localhost:7239'
const DEBUG_VERSION = 'selection-context-v1'

// ── 1. 允许文字选中 ──────────────────────────────────────────────────────────
const styleEl = document.createElement('style')
styleEl.textContent = '* { user-select: text !important; -webkit-user-select: text !important; }'
document.head.appendChild(styleEl)

// ── 2. 接收 page_hook.js（MAIN world）拦截到的消息 ──────────────────────────
let _copiedText = ''
let _copySelection = null
window.addEventListener('message', e => {
  if (e.data?.__cr === 'copy') {
    _copiedText = e.data.text
    _copySelection = e.data.selection || null
  }
  if (e.data?.__cr === 'chapter') handleChapterContent(e.data.url, e.data.raw)
  if (e.data?.__cr === 'progress') handleProgressContent(e.data.url, e.data.raw)
  if (e.data?.__cr === 'network-meta') {
    postDebug({
      source: 'network-discover',
      stage: e.data.source || '',
      url: e.data.url || '',
      rawLength: e.data.rawLength || 0,
      preview: e.data.preview || '',
    })
  }
})

// ── 3. 从 DOM / URL 读取当前阅读上下文 ────────────────────────────────────
function getReadingContext() {
  const topPath = (() => { try { return window.top.location.pathname } catch { return location.pathname } })()
  const bookId = topPath.split('/').pop() || ''
  const topDoc = (() => { try { return window.top.document } catch { return document } })()
  const bookTitle =
    topDoc.querySelector('.readerTopBar_title')?.textContent?.trim() ||
    topDoc.querySelector('[class*="readerTop"] [class*="title"]')?.textContent?.trim() ||
    topDoc.title.replace('微信读书', '').trim()
  const chapter =
    topDoc.querySelector('.readerChapterTitleWrap_title')?.textContent?.trim() ||
    topDoc.querySelector('[class*="chapterTitle"]')?.textContent?.trim() ||
    ''
  const chapterUid = (() => { try { return window.top.location.hash.replace('#', '') } catch { return '' } })()
  return { bookId, bookTitle, chapter, chapterUid }
}

function previewText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '')
}

function getQueryParam(queryText, name) {
  for (const part of String(queryText || '').split('&')) {
    const [key, value = ''] = part.split('=')
    if (key === name) {
      try { return decodeURIComponent(value.replace(/\+/g, ' ')) }
      catch { return value }
    }
  }
  return ''
}

function utf8FromBase64(value) {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

function textScore(text) {
  const s = String(text || '')
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const bad = (s.match(/\uFFFD/g) || []).length
  return cjk * 4 - bad * 20 + Math.min(s.length, 2000) / 200
}

function decodeWereadChapter(raw) {
  const source = String(raw || '').trim()
  if (!/^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]/.test(source)) return ''

  const bodyWithMarker = source.slice(32)
  const body = source.slice(33)
  const candidates = [
    body,
    bodyWithMarker,
    '5' + bodyWithMarker,
    '6' + bodyWithMarker,
    '7' + bodyWithMarker,
    'P' + body,
  ]

  let best = ''
  let bestScore = 0
  for (const candidate of candidates) {
    const decoded = utf8FromBase64(candidate)
    const score = textScore(decoded)
    if (score > bestScore) {
      best = decoded
      bestScore = score
    }
  }
  return bestScore > 80 ? best : ''
}

async function postDebug(data) {
  try {
    await fetch(`${RECEIVER}/debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ debugVersion: DEBUG_VERSION, ...getReadingContext(), ...data, timestamp: Date.now() }),
    })
  } catch {}
}

async function handleProgressContent(url, raw) {
  let data
  try { data = JSON.parse(raw) } catch { return }
  const ctx = getReadingContext()
  const book = data.book || {}
  const payload = {
    bookId: ctx.bookId,
    bookTitle: ctx.bookTitle,
    chapterTitle: ctx.chapter,
    wereadBookId: data.bookId || book.bookId || '',
    chapterUid: book.chapterUid || '',
    chapterIdx: book.chapterIdx || '',
    chapterOffset: Number.isFinite(book.chapterOffset) ? book.chapterOffset : 0,
    summary: book.summary || '',
    synckey: book.synckey || '',
    sourceUrl: url,
  }
  try {
    await fetch(`${RECEIVER}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    await postDebug({
      source: 'progress',
      stage: 'saved',
      chapterUid: payload.chapterUid,
      chapterOffset: payload.chapterOffset,
      summaryPreview: previewText(payload.summary),
    })
  } catch (e) {
    console.warn('[CoRead] progress POST failed:', e.message)
  }
}

// ── 4. 标注弹窗 ────────────────────────────────────────────────────────────
let popup = null

function removePopup() {
  if (popup) { popup.remove(); popup = null }
}

function showAnnotationPopup(selectedText, x, y) {
  removePopup()
  if (!selectedText) return

  popup = document.createElement('div')
  popup.id = 'coread-popup'
  Object.assign(popup.style, {
    position: 'fixed',
    left: Math.min(x - 150, window.innerWidth - 320) + 'px',
    top: Math.min(y + 12, window.innerHeight - 180) + 'px',
    zIndex: '2147483647',
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    padding: '12px',
    width: '300px',
    fontFamily: '-apple-system, sans-serif',
    fontSize: '14px',
  })

  popup.innerHTML = `
    <div style="color:#555;margin-bottom:8px;font-size:12px;line-height:1.4;max-height:60px;overflow:hidden;">
      "${selectedText.slice(0, 80)}${selectedText.length > 80 ? '…' : ''}"
    </div>
    <textarea id="coread-note" placeholder="共读话题（可留空直接发送）"
      style="width:100%;box-sizing:border-box;height:64px;border:1px solid #ddd;
             border-radius:4px;padding:6px;font-size:13px;resize:none;outline:none;"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
      <button id="coread-cancel"
        style="padding:4px 12px;border:1px solid #ddd;border-radius:4px;
               background:#f5f5f5;cursor:pointer;font-size:13px;">取消</button>
      <button id="coread-send"
        style="padding:4px 12px;border:none;border-radius:4px;
               background:#07c160;color:#fff;cursor:pointer;font-size:13px;">发送</button>
    </div>
  `
  document.documentElement.appendChild(popup)
  setTimeout(() => popup?.querySelector('#coread-note')?.focus(), 50)

  popup.querySelector('#coread-cancel').addEventListener('click', removePopup)
  popup.querySelector('#coread-send').addEventListener('click', () => {
    const userNote = popup.querySelector('#coread-note').value.trim()
    sendAnnotation(selectedText, userNote)
    removePopup()
  })
  popup.addEventListener('mousedown', e => e.stopPropagation())
}

function getDirectSelectionText() {
  const docs = [document]
  try {
    if (window.top?.document && window.top.document !== document) docs.push(window.top.document)
  } catch {}
  for (const doc of docs) {
    const text = doc.getSelection?.()?.toString?.()?.trim()
    if (text) return text
  }
  return ''
}

async function sendAnnotation(selectedText, userNote) {
  const ctx = getReadingContext()
  await trySendSelectionContent(ctx.chapterUid, ctx, selectedText, _copySelection)
  await trySendDomContent(ctx.chapterUid, ctx, selectedText)
  const payload = { ...ctx, selectedText, userNote, timestamp: Math.floor(Date.now() / 1000) }
  try {
    await fetch(`${RECEIVER}/annotation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    console.log('[CoRead] annotation sent', payload)
  } catch (e) {
    console.warn('[CoRead] receiver not reachable:', e.message)
  }
}

// ── 5. 注入 CoRead 按钮到 weread 工具栏 ───────────────────────────────────
function injectToolbarButton() {
  const container = document.querySelector('.reader_toolbar_itemContainer')
  if (!container || container.querySelector('.coread-toolbar-btn')) return

  const btn = document.createElement('div')
  btn.className = 'toolbarItem coread-toolbar-btn'
  btn.style.cssText = 'cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;width:56px;flex-shrink:0;'
  btn.innerHTML = `
    <div class="toolbarItem_icon" style="font-size:18px;line-height:1;color:#fff;">📖</div>
    <div class="toolbarItem_text" style="font-size:11px;color:#fff;margin-top:2px;">共读</div>
  `

  btn.addEventListener('click', async () => {
    try {
      const toolbar = document.querySelector('.reader_toolbar_container')
      const rect = toolbar?.getBoundingClientRect() || { left: 200, bottom: 300, width: 300 }

      // 触发 wr_copy 按钮，拦截其 clipboard 调用来取得选中文字
      _copiedText = getDirectSelectionText()
      _copySelection = null
      try { document.querySelector('.toolbarItem.wr_copy')?.click() }
      catch (e) {
        await postDebug({ source: 'toolbar', stage: 'wr-copy-click-error', message: e.message })
      }
      await new Promise(r => setTimeout(r, 250))

      if (!_copiedText) {
        console.warn('[CoRead] 未能获取选中文字，请确认 clipboard hook 已注入')
        await postDebug({ source: 'toolbar', stage: 'copy-empty' })
        return
      }
      showAnnotationPopup(_copiedText, rect.left + rect.width / 2, rect.bottom)
    } catch (e) {
      console.warn('[CoRead] toolbar click failed:', e)
      await postDebug({ source: 'toolbar', stage: 'click-error', message: e.message, stack: String(e.stack || '').slice(0, 600) })
    }
  })

  container.appendChild(btn)
  console.log('[CoRead] toolbar button injected')
}

// ── 6. 章节正文处理 ─────────────────────────────────────────────────────────

// 来自 page_hook.js 拦截到的网络响应（主路线）
async function handleChapterContent(url, raw) {
  const urlText = String(url || '')
  const queryText = urlText.split('?')[1] || ''
  const pathText = urlText.split('?')[0] || ''
  const ctx = getReadingContext()
  const bookId = getQueryParam(queryText, 'bookId') || ctx.bookId || ''
  const slotUid = getQueryParam(queryText, 'chapterUid') || pathText.split('/').filter(Boolean).pop()
  const chapterUid = /^t_\d+$/.test(slotUid) && ctx.chapter
    ? `${chapterFileName(ctx, '')}_${slotUid}`
    : slotUid
  if (!bookId || !chapterUid) return

  let text = ''
  try {
    const json = JSON.parse(raw)
    text = json.content || json.chapterContent || json.data?.content || ''
    if (Array.isArray(text)) text = text.join('\n\n')
  } catch {
    text = decodeWereadChapter(raw)
    if (!text && raw.length > 200 && !/^[0-9A-Fa-f]{32}[A-Za-z0-9+/=]/.test(String(raw || '').trim())) text = raw
  }
  await postDebug({
    source: 'network',
    stage: 'chapter-response',
    url,
    rawLength: raw.length,
    extractedTextLength: String(text || '').length,
    extractedPreview: previewText(text),
  })
  if (!text || text.length < 100) return

  text = text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId, chapterUid, text, source: 'network' }),
    })
    console.log(`[CoRead] chapter saved via network: bookId=${bookId} uid=${chapterUid} (${text.length} chars)`)
  } catch (e) {
    console.warn('[CoRead] content POST failed:', e.message)
  }
}

// DOM 捕获 ─────────────────────────────────────────────────────────────────
function captureCurrentChapterText() {
  const paras = document.querySelectorAll([
    '.wr_readerPage p',
    '.reader_chapter p',
    '[class*="readerPage"] p',
    '[class*="reader"] p',
    '.wr_readerPage [class*="content"]',
    '.reader_chapter [class*="content"]',
    '[class*="readerPage"] [class*="content"]',
  ].join(', '))
  const text = Array.from(paras)
    .map(p => p.textContent.trim())
    .filter(t => t.length > 0)
    .join('\n\n')
  if (text.length >= 100) return text

  const container = document.querySelector('.wr_readerPage, .reader_chapter, [class*="readerPage"]')
  return (container?.innerText || '')
    .split('\n')
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .join('\n\n')
}

function chapterFileName(ctx, chapterUid) {
  return chapterUid || ctx.chapterUid
    || (ctx.chapter ? ctx.chapter.replace(/[^\w一-龥]/g, '_').slice(0, 40) : '')
    || `t${Date.now()}`
}

async function trySendSelectionContent(chapterUid, ctx, selectedText, selection) {
  const text = selection?.context || ''
  const containsSelection = selectedText ? normalizeText(text).includes(normalizeText(selectedText)) : false
  await postDebug({
    ...ctx,
    source: 'selection',
    stage: 'annotation-send',
    textLength: text.length,
    contextLength: selection?.contextLength || 0,
    containsSelection,
    selectedTextLength: selectedText.length,
    selectedPreview: previewText(selectedText),
    textPreview: previewText(text),
    ancestorTag: selection?.ancestorTag || '',
    ancestorClass: String(selection?.ancestorClass || '').slice(0, 120),
  })
  if (!text || text.length < 100 || !containsSelection) return
  const uid = chapterFileName(ctx, chapterUid)
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: ctx.bookId, chapterUid: uid, text, selectedText, source: 'selection' }),
    })
    console.log(`[CoRead] chapter saved via selection: ${text.length} chars uid=${uid}`)
  } catch (e) {
    console.warn('[CoRead] selection content POST failed:', e.message)
  }
}

async function trySendDomContent(chapterUid, ctxOverride, selectedText = '') {
  const ctx = ctxOverride || getReadingContext()
  const text = captureCurrentChapterText()
  const containsSelection = selectedText ? normalizeText(text).includes(normalizeText(selectedText)) : null
  await postDebug({
    ...ctx,
    source: 'dom',
    stage: selectedText ? 'annotation-send' : 'chapter-change',
    textLength: text.length,
    containsSelection,
    selectedTextLength: selectedText.length,
    selectedPreview: previewText(selectedText),
    textPreview: previewText(text),
  })
  if (!text || text.length < 100) return
  if (selectedText && !containsSelection) return
  const uid = chapterFileName(ctx, chapterUid)
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: ctx.bookId, chapterUid: uid, text, selectedText, source: 'dom' }),
    })
    console.log(`[CoRead] chapter saved via DOM: ${text.length} chars uid=${uid}`)
  } catch (e) {
    console.warn('[CoRead] DOM content POST failed:', e.message)
  }
}

// ── 7. 章节切换检测 ─────────────────────────────────────────────────────────
let lastChapterUid = ''
let lastChapterTitle = ''

function onChapterChange(ctx) {
  if (ctx.chapterUid === lastChapterUid && ctx.chapter === lastChapterTitle) return
  if (lastChapterUid && lastChapterTitle) {
    reportChapterComplete(lastChapterUid, lastChapterTitle)
  }
  lastChapterUid = ctx.chapterUid
  lastChapterTitle = ctx.chapter
  setTimeout(() => trySendDomContent(ctx.chapterUid), 1500)
}

async function reportChapterComplete(chapterUid, chapterTitle) {
  const ctx = getReadingContext()
  try {
    await fetch(`${RECEIVER}/chapter-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: ctx.bookId, bookTitle: ctx.bookTitle, chapterUid, chapterTitle }),
    })
  } catch (e) {
    console.warn('[CoRead] chapter-complete failed:', e.message)
  }
}


// ── 9. MutationObserver：章节切换 + 工具栏检测 ─────────────────────────────
const observer = new MutationObserver(() => {
  const ctx = getReadingContext()
  if (ctx.chapter !== lastChapterTitle) onChapterChange(ctx)
  injectToolbarButton()
})
observer.observe(document.body, { childList: true, subtree: true })

// 点击空白关闭弹窗
document.addEventListener('mousedown', e => {
  if (popup && !popup.contains(e.target)) removePopup()
}, true)

// 初始化
const initCtx = getReadingContext()
lastChapterUid = initCtx.chapterUid
lastChapterTitle = initCtx.chapter
postDebug({ source: 'lifecycle', stage: 'content-loaded' })
console.log('[CoRead] content script loaded', initCtx)
