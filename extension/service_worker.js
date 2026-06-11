/**
 * CoRead service worker
 * 拦截 /web/book/chapter/e_{N} 请求，提取章节正文，转发到本地接收端。
 *
 * 实测结论（2026-06-12）：
 * - 章节内容走标准 HTTP fetch，接口为 /web/book/chapter/e_{chapterIdx}
 * - DOM textContent 返回正确汉字，无字体混淆
 * - 无 WebSocket
 */

const RECEIVER = 'http://localhost:7239'

self.addEventListener('fetch', event => {
  const url = event.request.url
  if (!url.includes('weread.qq.com/web/book/chapter/e_')) return

  event.respondWith(
    fetch(event.request.clone()).then(async response => {
      try {
        const cloned = response.clone()
        const raw = await cloned.text()
        await extractAndForward(url, raw)
      } catch (e) {
        console.warn('[CoRead SW] extract error', e)
      }
      return response
    })
  )
})

async function extractAndForward(url, rawText) {
  // URL 格式：https://weread.qq.com/web/book/chapter/e_{chapterIdx}
  // 查询参数可能带 bookId, chapterUid 等
  const urlObj = new URL(url)
  const bookId = urlObj.searchParams.get('bookId') || ''
  const chapterUid = urlObj.searchParams.get('chapterUid') || urlObj.pathname.split('/').pop()

  let text = ''
  try {
    const json = JSON.parse(rawText)
    // 尝试常见字段：content / chapterContent / data.content
    text = json.content
      || json.chapterContent
      || (json.data && json.data.content)
      || ''
    // 如果是数组（段落数组），拼接
    if (Array.isArray(text)) text = text.join('\n\n')
    // 还没拿到就 fallback 到 raw
    if (!text && rawText.length > 200) text = rawText
  } catch {
    // 非 JSON（纯文本），直接用
    if (rawText.length > 200) text = rawText
  }

  if (!text || text.length < 100) return

  // 去掉 HTML 标签（如果有）
  text = text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()

  try {
    await fetch(`${RECEIVER}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId, chapterUid, text, sourceUrl: url }),
    })
    console.log(`[CoRead SW] content saved: bookId=${bookId} uid=${chapterUid} (${text.length} chars)`)
  } catch {
    // 接收端未启动时静默失败
  }
}

// ── 来自 content.js 的 DOM 提取内容（补充路线） ────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type !== 'COREAD_DOM_CONTENT') return
  const { bookId, chapterUid, text } = event.data
  if (!text || text.length < 100) return
  fetch(`${RECEIVER}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId, chapterUid, text, source: 'dom' }),
  }).catch(() => {})
})

// ── Side Panel ────────────────────────────────────────────────────────────────
// 点击扩展图标直接打开 side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

// 来自 content.js FAB 点击的消息 → 程序化打开 side panel
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === 'openPanel' && sender.tab?.id) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {})
  }
})
