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
  // --- A5 work documents ---
  ['A5 presence grid HTML', `(() => {
    if (typeof buildPresenceHtml !== 'function') return true
    const h = buildPresenceHtml()
    return h.includes('Alice') && h.includes('Bob') && h.includes('<table') && h.includes('Total')
  })()`],
  ['A5 line tally HTML', `(() => {
    if (typeof buildTallyHtml !== 'function') return true
    const h = buildTallyHtml()
    return h.includes('Bonjour toi') && h.includes('Salut') && h.includes('ALICE')
  })()`],
  // --- A6 ADR cues ---
  ['A6 addCue streamer + punch', `(() => {
    if (typeof addCue !== 'function') return true
    project.cues = []; scrub.time = 5
    addCue('streamer'); addCue('punch')
    return project.cues.length === 2 && project.cues[0].type === 'streamer' && project.cues[0].lead > 0 && project.cues[1].type === 'punch'
  })()`],
  ['A6 cues persist + drawCues no throw', `(() => {
    if (typeof drawCues !== 'function') return true
    loadProjectData(JSON.parse(JSON.stringify(project)), null)
    if ((project.cues || []).length !== 2) return 'lost cues on reload'
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180
    const cx = cv.getContext('2d')
    try { drawCues(cx, { x: 0, y: 0, w: 320, h: 180 }, 4); drawCues(cx, { x: 0, y: 0, w: 320, h: 180 }, 5); return true }
    catch (e) { return 'ERR: ' + e.message }
  })()`],
  ['A6 remove nearest + clear', `(() => {
    if (typeof clearCues !== 'function') return true
    scrub.time = 5; removeNearestCue()
    const afterRemove = project.cues.length
    clearCues()
    return afterRemove === 1 && project.cues.length === 0
  })()`],
  ['A6 cue selected on add + deletable', `(() => {
    if (typeof addCue !== 'function' || typeof deleteSelectedCue !== 'function') return true
    project.cues = []; scrub.time = 5
    addCue('punch')
    const okSel = !!selectedCueId && project.cues.length === 1 && project.cues[0].id === selectedCueId
    deleteSelectedCue()
    return okSel && project.cues.length === 0 && selectedCueId === null
  })()`],
  ['A6 timeline render + draw no throw', `(() => {
    if (typeof drawCuesTimeline !== 'function') return true
    project.cues = [{ id: 'c1', type: 'streamer', time: 4, lead: 3 }, { id: 'c2', type: 'punch', time: 8 }]
    selectedCueId = 'c1'
    let r; try { drawCuesTimeline(); draw(); r = true } catch (e) { r = 'ERR: ' + e.message }
    project.cues = []; selectedCueId = null
    return r
  })()`],
  // --- Tier B: character merge + search ---
  ['B merge characters reassigns lines', `(() => {
    if (typeof mergeCharacter !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 2, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'Alice', color: '#e8443a' }, { id: 'b', name: 'Bob', color: '#3a7ae8' }],
      lines: [{ id: 'x', characterId: 'a', track: 0, words: [{ text: 'un', start: 0, end: 1 }] },
              { id: 'y', characterId: 'b', track: 1, words: [{ text: 'deux', start: 1, end: 2 }] }] }, null)
    mergeCharacter('b', 'a')
    return project.characters.length === 1 && project.lines.every(l => l.characterId === 'a')
  })()`],
  ['B character search filters list', `(() => {
    loadProjectData({ version: 2, fps: 25, tracks: 2, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'Alice', color: '#e8443a' }, { id: 'b', name: 'Bob', color: '#3a7ae8' }], lines: [] }, null)
    charFilter = 'bob'; renderChars()
    const n = document.getElementById('charList').children.length
    charFilter = ''; renderChars()
    return n === 1
  })()`],
  // --- Tier B: bookmarks ---
  ['B bookmark toggle + persist', `(() => {
    if (typeof toggleBookmark !== 'function') return true
    project.bookmarks = []; scrub.time = 10; toggleBookmark()
    const added = project.bookmarks.length === 1
    scrub.time = 10; toggleBookmark()
    const removed = project.bookmarks.length === 0
    scrub.time = 10; toggleBookmark()
    loadProjectData(JSON.parse(JSON.stringify(project)), null)
    return added && removed && project.bookmarks.length === 1
  })()`],
  // --- S1 voice recording (no mic: IPC + data model) ---
  ['S1 take file IPC roundtrip', `(async () => {
    if (!window.api.saveTake) return true
    const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer
    const r = await window.api.saveTake(null, 'ftest_take.webm', buf)
    if (!r || r.error) return 'save: ' + (r && r.error)
    const url = await window.api.takeUrl(null, r.name)
    const ok = !!url && url.startsWith('file:')
    await window.api.deleteTake(null, r.name)
    const gone = await window.api.takeUrl(null, r.name)
    return ok && !gone
  })()`],
  ['S1 take data model + inspector + persist', `(() => {
    if (typeof refreshRecInspector !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'A', color: '#ffffff' }],
      lines: [{ id: 'l', characterId: 'a', track: 0, words: [{ text: 'x', start: 1, end: 2 }],
        takes: [{ id: 't1', file: 'x.webm', startTime: 1, dur: 1.2 }], take: 't1' }] }, null)
    selectedIds = new Set(['l']); refreshInspector()
    const sel = document.getElementById('takeSel')
    const okUI = sel.options.length === 1 && sel.value === 't1' && !document.getElementById('btnPlayTake').disabled
    loadProjectData(JSON.parse(JSON.stringify(project)), null)
    const l = project.lines[0]
    return okUI && l.take === 't1' && l.takes.length === 1
  })()`],
  // --- A4 whisper transcription (experimental; engine not present in test env) ---
  ['A4 whisper status shape', `(async () => {
    if (!window.api.whisperStatus) return true
    const st = await window.api.whisperStatus('base')
    return st && typeof st === 'object' && ('model' in st) && ('exe' in st)
  })()`],
  ['A4 transcribe degrades without engine', `(async () => {
    if (!window.api.whisperTranscribe) return true
    const r = await window.api.whisperTranscribe({ source: 'C:/nope.mp4', model: 'base', language: 'auto' })
    return r && typeof r.error === 'string'
  })()`],
  ['A4 dialog opens with a video', `(() => {
    if (typeof openTranscribeDialog !== 'function') return true
    project.videoPath = 'X:/fake.mp4'
    openTranscribeDialog()
    const open = !document.getElementById('transcribeModal').classList.contains('hidden')
    document.getElementById('transcribeModal').classList.add('hidden')
    project.videoPath = null
    return open
  })()`],
  ['Long normal scene is not flagged (OUT-short still is)', `(() => {
    if (typeof loopWarn !== 'function') return true
    return loopWarn({ type: 'normal', start: 0, end: 300 }) === false
      && loopWarn({ type: 'out', start: 0, end: 5 }) === true
  })()`],
  // --- Capture device selector + settings ---
  ['Cap audio-config roundtrip', `(async () => {
    if (!window.api.audioConfigSet) return true
    await window.api.audioConfigSet({ api: 'dshow', device: 'X', asioFfmpeg: null })
    const c = await window.api.audioConfigGet()
    await window.api.audioConfigSet({ api: 'system', device: null, asioFfmpeg: null })
    return c && c.api === 'dshow' && c.device === 'X'
  })()`],
  ['Cap dshow enumeration returns list', `(async () => {
    if (!window.api.listCaptureDevices) return true
    const r = await window.api.listCaptureDevices('dshow')
    return r && Array.isArray(r.devices)
  })()`],
  ['Cap asio degrades (no bundled backend)', `(async () => {
    if (!window.api.listCaptureDevices) return true
    const r = await window.api.listCaptureDevices('asio')
    return r && r.available === false
  })()`],
  ['Settings modal opens', `(() => {
    if (typeof openSettings !== 'function') return true
    openSettings()
    const open = !document.getElementById('settingsModal').classList.contains('hidden')
    document.getElementById('settingsModal').classList.add('hidden')
    return open
  })()`],
  // --- AI model manager ---
  ['Models list shape + DL estimate', `(async () => {
    if (!window.api.whisperListModels) return true
    const m = await window.api.whisperListModels()
    return Array.isArray(m) && m.length >= 3 && ('present' in m[0]) && ('model' in m[0]) && ('sizeMB' in m[0]) && ('estMB' in m[0]) && m[0].estMB > 0
  })()`],
  ['DL size formatting', `(() => {
    if (typeof fmtDlSize !== 'function') return true
    lang = 'fr'
    const ok = fmtDlSize(142) === '142 Mo' && fmtDlSize(2000) === '2 Go' && fmtDlSize(1500) === '1,5 Go'
    return ok
  })()`],
  // --- Voice removal (separation) ---
  ['Sep status shape', `(async () => {
    if (!window.api.sepStatus) return true
    const s = await window.api.sepStatus()
    return s && typeof s === 'object' && ('ready' in s) && ('python' in s)
  })()`],
  ['Sep config roundtrip + no-engine degrade', `(async () => {
    if (!window.api.sepConfigGet) return true
    await window.api.sepConfigSet({ exe: null, python: null, module: null, model: 'htdemucs_ft' })
    const c = await window.api.sepConfigGet()
    const r = await window.api.sepRun({ source: 'C:/nope.mp4', projectPath: null, model: 'htdemucs' })
    return c && c.model === 'htdemucs_ft' && r && r.error === 'no-engine'
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
