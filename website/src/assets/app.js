/* LibreRythmo landing — progressive enhancement.
 * 1. Language auto-routing (browser language → EN / FR / ES), only from the
 *    default English entry page, and never overriding an explicit choice.
 * 2. Hero download button adapts to the visitor's OS.
 * 3. Live-refresh version, build date and download links from the GitHub API,
 *    so the page stays current even between static rebuilds.
 */
(function () {
  'use strict'
  var REPO = 'fusorf/LibreRythmo'
  var RELEASES_LATEST = 'https://github.com/' + REPO + '/releases/latest'
  var current = document.documentElement.lang || 'en'

  // --- 1. language routing ------------------------------------------------
  var langLinks = {}
  document.querySelectorAll('.nav__lang a[hreflang]').forEach(function (a) {
    var l = a.getAttribute('hreflang')
    langLinks[l] = a.getAttribute('href')
    a.addEventListener('click', function () {
      try { localStorage.setItem('lr-lang', l) } catch (e) {}
    })
  })

  try {
    var stored = localStorage.getItem('lr-lang')
    if (!stored && current === 'en' && !sessionStorage.getItem('lr-routed')) {
      var pref = (navigator.language || 'en').slice(0, 2).toLowerCase()
      var target = pref === 'fr' ? 'fr' : pref === 'es' ? 'es' : 'en'
      sessionStorage.setItem('lr-routed', '1')
      if (target !== 'en' && langLinks[target]) {
        location.replace(langLinks[target])
        return
      }
    }
  } catch (e) {}

  // --- 2. OS-aware hero button -------------------------------------------
  function detectOS() {
    var ua = (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform || navigator.userAgent || ''
    ua = ua.toLowerCase()
    if (ua.indexOf('win') === 0 || ua.indexOf('windows') !== -1) return 'windows'
    if (ua.indexOf('mac') !== -1) return 'macos'
    if (ua.indexOf('linux') !== -1 || ua.indexOf('x11') !== -1) return 'linux'
    return null
  }
  var OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }
  var cta = document.getElementById('cta-download')
  function applyOS() {
    if (!cta) return
    var os = detectOS()
    if (!os) return
    var href = cta.getAttribute('data-dl-' + os)
    var tpl = cta.getAttribute('data-cta-template') || cta.textContent
    if (href) cta.setAttribute('href', href)
    cta.textContent = tpl.replace('{os}', OS_LABEL[os])
  }
  applyOS()

  // --- 3. live refresh from the GitHub API -------------------------------
  function slotFor(name) {
    var n = name.toLowerCase()
    if (/setup.*\.exe$/.test(n) || /\.exe$/.test(n)) return 'windows-installer'
    if (/\.zip$/.test(n)) return 'windows-portable'
    if (/arm64.*\.dmg$/.test(n)) return 'macos-arm'
    if (/(x64|intel).*\.dmg$/.test(n)) return 'macos-intel'
    if (/\.dmg$/.test(n)) return 'macos-arm'
    if (/\.appimage$/.test(n)) return 'linux-appimage'
    if (/\.deb$/.test(n)) return 'linux-deb'
    if (/\.pacman$/.test(n)) return 'linux-pacman'
    return null
  }
  function fmtDate(iso) {
    try {
      return new Intl.DateTimeFormat(current, { year: 'numeric', month: 'long', day: 'numeric' })
        .format(new Date(iso))
    } catch (e) { return iso.slice(0, 10) }
  }
  function fillTpl(el, tag, date) {
    if (!el) return
    var tpl = el.getAttribute('data-tpl')
    if (tpl) el.textContent = tpl.replace('{version}', tag).replace('{date}', date)
  }

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
    headers: { 'Accept': 'application/vnd.github+json' },
  }).then(function (r) { return r.ok ? r.json() : null }).then(function (data) {
    if (!data || !data.tag_name) return
    var links = {}
    ;(data.assets || []).forEach(function (a) {
      var s = slotFor(a.name)
      if (s && !links[s]) links[s] = a.browser_download_url
    })
    var tag = data.tag_name
    var date = fmtDate(data.published_at)

    fillTpl(document.getElementById('hero-release'), tag, date)
    fillTpl(document.getElementById('dl-current'), tag, date)

    document.querySelectorAll('.dl__card a[data-slot]').forEach(function (a) {
      var u = links[a.getAttribute('data-slot')]
      if (u) a.setAttribute('href', u)
    })
    if (cta) {
      if (links['windows-installer']) cta.setAttribute('data-dl-windows', links['windows-installer'])
      if (links['macos-arm']) cta.setAttribute('data-dl-macos', links['macos-arm'])
      if (links['linux-appimage']) cta.setAttribute('data-dl-linux', links['linux-appimage'])
      applyOS()
    }
  }).catch(function () { /* offline / rate-limited — static values stand */ })

  // total downloads across all releases → #dl-downloads
  fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=100', {
    headers: { 'Accept': 'application/vnd.github+json' },
  }).then(function (r) { return r.ok ? r.json() : null }).then(function (list) {
    if (!list) return
    var total = 0
    list.forEach(function (rel) {
      (rel.assets || []).forEach(function (a) { total += a.download_count || 0 })
    })
    var el = document.getElementById('dl-downloads')
    if (el && el.getAttribute('data-tpl')) {
      var num
      try { num = new Intl.NumberFormat(current).format(total) } catch (e) { num = String(total) }
      el.textContent = el.getAttribute('data-tpl').replace('{count}', num)
    }
  }).catch(function () {})
})()
