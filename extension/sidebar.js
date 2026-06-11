const RECEIVER = 'http://localhost:7239'
let sseConn = null

function esc(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function setDot(connected) {
  document.getElementById('dot').style.background = connected ? '#07c160' : '#ddd'
}

function addBubble(role, content, extra, note) {
  const msgs = document.getElementById('msgs')
  const el = document.createElement('div')

  if (role === 'annotation') {
    el.className = 'msg-annotation'
    el.innerHTML = `<span class="label">📌 新划线</span>
      ${extra ? `<div class="quote">"${esc(extra)}"</div>` : ''}
      <div class="text">${esc(content)}</div>
      ${note ? `<div class="user-note">💬 ${esc(note)}</div>` : ''}`
  } else if (role === 'user') {
    el.className = 'msg-user'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  } else {
    el.className = 'msg-assistant'
    el.innerHTML = `<div class="bubble">${esc(content)}</div>`
  }

  msgs.appendChild(el)
  msgs.scrollTop = msgs.scrollHeight
}

function connect() {
  if (sseConn) return
  sseConn = new EventSource(`${RECEIVER}/events`)
  sseConn.onopen = () => setDot(true)
  sseConn.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data)
      if (d.type === 'connected') { setDot(true); return }
      if (d.type !== 'message') return
      if (d.role === 'assistant') addBubble('assistant', d.content)
      else if (d.role === 'annotation') addBubble('annotation', d.content, d.selectedText, d.userNote)
    } catch {}
  }
  sseConn.onerror = () => {
    setDot(false)
    sseConn.close()
    sseConn = null
    setTimeout(connect, 5000)
  }
}

async function submit() {
  const input = document.getElementById('input')
  const content = input.value.trim()
  if (!content) return
  input.value = ''
  input.style.height = 'auto'
  addBubble('user', content)
  try {
    await fetch(`${RECEIVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch (e) {
    console.warn('[CoRead] chat POST failed:', e.message)
  }
}

document.getElementById('send-btn').addEventListener('click', submit)
document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
})
document.getElementById('input').addEventListener('input', function () {
  this.style.height = 'auto'
  this.style.height = Math.min(this.scrollHeight, 120) + 'px'
})

async function loadHistory() {
  try {
    const items = await fetch(`${RECEIVER}/history`).then(r => r.json())
    for (const d of items) {
      if (d.role === 'annotation') addBubble('annotation', d.content, d.selectedText, d.userNote)
      else if (d.role === 'user') addBubble('user', d.content)
      else if (d.role === 'assistant') addBubble('assistant', d.content)
    }
  } catch {}
}

loadHistory().then(connect)
