// 运行在页面主世界，拦截 weread 的 clipboard 调用和章节正文 API
;(function () {
  // ── clipboard 拦截 ──────────────────────────────────────────────────────────
  var orig = navigator.clipboard?.writeText?.bind(navigator.clipboard)
  if (orig) {
    navigator.clipboard.writeText = function (text) {
      window.postMessage({ __cr: 'copy', text: text }, '*')
      return orig(text)
    }
  }
  var oe = document.execCommand.bind(document)
  document.execCommand = function (cmd) {
    var r = oe.apply(document, arguments)
    if (cmd === 'copy') {
      var t = document.getSelection?.()?.toString?.() || ''
      if (t) window.postMessage({ __cr: 'copy', text: t }, '*')
    }
    return r
  }

  // ── 章节正文 API 拦截 ────────────────────────────────────────────────────────
  var origFetch = window.fetch
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || ''
    var result = origFetch.apply(this, arguments)
    if (url.indexOf('/web/book/chapter/e_') !== -1) {
      result.then(function (response) {
        response.clone().text().then(function (raw) {
          window.postMessage({ __cr: 'chapter', url: url, raw: raw }, '*')
        }).catch(function () {})
      }).catch(function () {})
    }
    return result
  }
})()
