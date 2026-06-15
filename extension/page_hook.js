// 运行在页面主世界，拦截 weread 的 clipboard 调用和章节正文 API
;(function () {
  function strUrl(url) {
    return typeof url === 'string' ? url : (url && url.url) || ''
  }

  function shouldDiscoverUrl(url) {
    var text = String(url || '')
    return text.indexOf('/web/') !== -1 && text.indexOf('localhost:7239') === -1
  }

  function shouldCaptureChapterUrl(url) {
    return String(url || '').indexOf('/web/book/chapter') !== -1
  }

  function shouldCaptureProgressUrl(url) {
    return String(url || '').indexOf('/web/book/getProgress') !== -1
  }

  function reportNetworkMeta(url, raw, source) {
    if (!shouldDiscoverUrl(url)) return
    window.postMessage({
      __cr: 'network-meta',
      url: String(url || ''),
      source: source,
      rawLength: String(raw || '').length,
      preview: cleanText(String(raw || '').slice(0, 300)),
    }, '*')
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim()
  }

  function selectionContext() {
    var sel = document.getSelection?.()
    if (!sel || sel.rangeCount === 0) return null
    var range = sel.getRangeAt(0)
    var node = range.commonAncestorContainer
    var el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
    var candidates = []
    var cur = el
    while (cur && cur !== document.body && candidates.length < 8) {
      var text = cleanText(cur.textContent || '')
      if (text) candidates.push(text)
      cur = cur.parentElement
    }
    candidates.sort(function (a, b) { return a.length - b.length })
    var selected = cleanText(sel.toString())
    var context = candidates.find(function (text) {
      return text.length >= selected.length && text.indexOf(selected) !== -1
    }) || candidates[0] || ''
    return {
      text: selected,
      context: context.slice(0, 4000),
      contextLength: context.length,
      ancestorTag: el?.tagName || '',
      ancestorClass: el?.className || '',
    }
  }

  // ── clipboard 拦截 ──────────────────────────────────────────────────────────
  var orig = navigator.clipboard?.writeText?.bind(navigator.clipboard)
  if (orig) {
    navigator.clipboard.writeText = function (text) {
      var ctx = selectionContext()
      window.postMessage({ __cr: 'copy', text: text, selection: ctx }, '*')
      return orig(text)
    }
  }
  var oe = document.execCommand.bind(document)
  document.execCommand = function (cmd) {
    var r = oe.apply(document, arguments)
    if (cmd === 'copy') {
      var t = document.getSelection?.()?.toString?.() || ''
      if (t) window.postMessage({ __cr: 'copy', text: t, selection: selectionContext() }, '*')
    }
    return r
  }

  // ── 章节正文 API 拦截 ────────────────────────────────────────────────────────
  var origFetch = window.fetch
  window.fetch = function (input, init) {
    var url = strUrl(input)
    var result = origFetch.apply(this, arguments)
    if (shouldDiscoverUrl(url)) {
      result.then(function (response) {
        response.clone().text().then(function (raw) {
          reportNetworkMeta(url, raw, 'fetch')
          if (shouldCaptureChapterUrl(url)) {
            window.postMessage({ __cr: 'chapter', url: url, raw: raw }, '*')
          }
          if (shouldCaptureProgressUrl(url)) {
            window.postMessage({ __cr: 'progress', url: url, raw: raw }, '*')
          }
        }).catch(function () {})
      }).catch(function () {})
    }
    return result
  }

  var origOpen = XMLHttpRequest.prototype.open
  var origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__crUrl = url
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    if (shouldDiscoverUrl(this.__crUrl)) {
      this.addEventListener('load', function () {
        try {
          var raw = this.responseText || ''
          if (raw) {
            reportNetworkMeta(this.__crUrl, raw, 'xhr')
            if (shouldCaptureChapterUrl(this.__crUrl)) {
              window.postMessage({ __cr: 'chapter', url: this.__crUrl, raw: raw }, '*')
            }
            if (shouldCaptureProgressUrl(this.__crUrl)) {
              window.postMessage({ __cr: 'progress', url: this.__crUrl, raw: raw }, '*')
            }
          }
        } catch (_) {}
      })
    }
    return origSend.apply(this, arguments)
  }
})()
