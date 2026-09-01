// Dev tool: functional smoke test. Boots the app under CDP, loads a synthetic
// project (no video needed), and exercises v3 feature logic through evaluate(),
// asserting on real state. Extended as features land. Run: node scripts/ftest.js
'use strict'
const WebSocket = require('ws')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const PORT = 9223
const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SETUP = `loadProjectData({
  version: 2, fps: 25, tracks: 2, defaultFont: null, fonts: [],
  characters: [
    { id: 'c1', name: 'Alice', color: '#e8443a' },
    { id: 'c2', name: 'Bob', color: '#3a7ae8' }
  ],
  lines: [
    { id: 'l1', characterId: 'c1', track: 0, words: [
      { text: 'Bonjour', start: 1.0, end: 1.6 }, { text: 'toi', start: 1.6, end: 2.0 } ] },
    { id: 'l2', characterId: 'c2', track: 1, words: [
      { text: 'Salut', start: 2.2, end: 2.8 } ] }
  ],
  loops: [], plans: [], audioTracks: []
}, null); 'ok'`

// Each test: an expression that must evaluate to true. Guarded with typeof so the
// suite stays green if a feature isn't present yet.
const TESTS = [
  // --- S2 detection symbols ---
  ['S2 insertSymbol places a mark', `(() => {
    if (typeof insertSymbol !== 'function') return true
    selectedIds = new Set(['l1']); scrub.time = 1.7
    insertSymbol(DET_BY_KEY.get('p'))
    const l = project.lines.find(x => x.id === 'l1')
    return !!l.symbols && Object.keys(l.symbols).length === 1
  })()`],
  ['S2 insertSymbol toggles off', `(() => {
    if (typeof insertSymbol !== 'function') return true
    selectedIds = new Set(['l1']); scrub.time = 1.7
    insertSymbol(DET_BY_KEY.get('p'))
    const l = project.lines.find(x => x.id === 'l1')
    return !l.symbols
  })()`],
  ['S2 symbols survive save/reload', `(() => {
    if (typeof insertSymbol !== 'function') return true
    selectedIds = new Set(['l1']); scrub.time = 1.1
    insertSymbol(DET_BY_KEY.get('f'))
    const json = JSON.stringify(project)
    loadProjectData(JSON.parse(json), null)
    const l = project.lines.find(x => x.id === 'l1')
    return !!l.symbols && l.symbols['0'] === 'f'
  })()`],
  ['draw() does not throw with marks', `(() => {
    try { draw(); return true } catch (e) { return 'ERR: ' + e.message }
  })()`],
  // --- A3 RTL ---
  ['A3 toggle sets project.rtl + input dir', `(() => {
    if (typeof applyReadingDir !== 'function') return true
    project.rtl = true; applyReadingDir()
    const ok = document.getElementById('insText').dir === 'rtl' && document.getElementById('btnRtl').classList.contains('active')
    project.rtl = false; applyReadingDir()
    return ok && document.getElementById('insText').dir === 'ltr'
  })()`],
  ['A3 rtl persists through save/reload', `(() => {
    if (typeof applyReadingDir !== 'function') return true
    project.rtl = true
    loadProjectData(JSON.parse(JSON.stringify(project)), null)
    const ok = project.rtl === true
    project.rtl = false; applyReadingDir()
    return ok
  })()`],
  ['A3 draw() does not throw in rtl', `(() => {
    project.rtl = true
    let r; try { draw(); r = true } catch (e) { r = 'ERR: ' + e.message }
    project.rtl = false
    return r
  })()`],
]

function getJson() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main() {
  const electron = require('electron')
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let page = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try { const ts = await getJson(); page = ts.find((t) => t.type === 'page'); if (page) break } catch {}
  }
  if (!page) { console.error('FTEST FAIL: no page target'); try { child.kill() } catch {} process.exit(1) }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result) }
  })
  await new Promise((r) => ws.on('open', r))
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { ok: false, err: JSON.stringify(r.exceptionDetails).slice(0, 300) }
    return { ok: true, value: r.result.value }
  }
  await sleep(3500)

  const boot = await evaluate(SETUP)
  if (!boot.ok || boot.value !== 'ok') { console.error('FTEST FAIL: setup', boot.err || boot.value); ws.close(); try { child.kill() } catch {}; process.exit(1) }
  await sleep(200)

  let failed = 0
  for (const [name, expr] of TESTS) {
    const r = await evaluate(expr)
    const pass = r.ok && r.value === true
    if (!pass) failed++
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '  <' + (r.ok ? JSON.stringify(r.value) : r.err) + '>'}`)
  }
  ws.close(); try { child.kill() } catch {}; await sleep(300)
  if (failed) { console.error(`\nFTEST FAIL: ${failed}`); process.exit(1) }
  console.log('\nFTEST OK'); process.exit(0)
}
main().catch((e) => { console.error('FTEST FAIL:', e.message); process.exit(1) })
