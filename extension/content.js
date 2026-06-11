/**
 * CoRead content script — 运行于 weread.qq.com/web/reader/*
 */

const RECEIVER = 'http://localhost:7239'

// ── 1. 允许文字选中 ──────────────────────────────────────────────────────────
const styleEl = document.createElement('style')
styleEl.textContent = '* { user-select: text !important; -webkit-user-select: text !important; }'
document.head.appendChild(styleEl)

// ── 2. 接收 page_hook.js（MAIN world）拦截到的消息 ──────────────────────────
let _copiedText = ''
window.addEventListener('message', e => {
  if (e.data?.__cr === 'copy') _copiedText = e.data.text
  if (e.data?.__cr === 'chapter') handleChapterContent(e.data.url, e.data.raw)
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

async function sendAnnotation(selectedText, userNote) {
  const ctx = getReadingContext()
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
    const toolbar = document.querySelector('.reader_toolbar_container')
    const rect = toolbar?.getBoundingClientRect() || { left: 200, bottom: 300, width: 300 }

    // 触发 wr_copy 按钮，拦截其 clipboard 调用来取得选中文字
    _copiedText = ''
    document.querySelector('.toolbarItem.wr_copy')?.click()
    await new Promise(r => setTimeout(r, 250))

    if (!_copiedText) {
      console.warn('[CoRead] 未能获取选中文字，请确认 clipboard hook 已注入')
      return
    }
    showAnnotationPopup(_copiedText, rect.left + rect.width / 2, rect.bottom)
  })

  container.appendChild(btn)
  console.log('[CoRead] toolbar button injected')
}

// ── 6. 章节正文处理 ─────────────────────────────────────────────────────────

// 来自 page_hook.js 拦截到的网络响应（主路线）
async function handleChapterContent(url, raw) {
  const urlObj = new URL(url)
  const bookId = urlObj.searchParams.get('bookId') || ''
  const chapterUid = urlObj.searchParams.get('chapterUid') || url.split('/').pop().split('?')[0]
  if (!bookId || !chapterUid) return

  let text = ''
  try {
    const json = JSON.parse(raw)
    text = json.content || json.chapterContent || json.data?.content || ''
    if (Array.isArray(text)) text = text.join('\n\n')
    if (!text && raw.length > 200) text = raw
  } catch {
    if (raw.length > 200) text = raw
  }
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
  const paras = document.querySelectorAll(
    '.wr_readerPage p, .reader_chapter p, [class*="readerPage"] p, [class*="reader"] p'
  )
  if (!paras.length) return ''
  return Array.from(paras)
    .map(p => p.textContent.trim())
    .filter(t => t.length > 0)
    .join('\n\n')
}

async function trySendDomContent(chapterUid) {
  const ctx = getReadingContext()
  const text = captureCurrentChapterText()
  if (!text || text.length < 100) return
  // chapterUid fallback：hash 拿不到时用章节标题 slug
  const uid = chapterUid || ctx.chapterUid
    || (ctx.chapter ? ctx.chapter.replace(/[^\w一-龥]/g, '_').slice(0, 40) : '')
    || `t${Date.now()}`
  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: ctx.bookId, chapterUid: uid, text, source: 'dom' }),
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
    trySendDomContent(lastChapterUid)
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
console.log('[CoRead] content script loaded', initCtx)
