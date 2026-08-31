// Dev tool: drives the running app (electron . --remote-debugging-port=9222)
// to load an enriched Xenoblade project and capture marketing screenshots.
'use strict'
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 9222
const SRC_PROJECT = 'C:/Users/user/OneDrive/Vidéos/doublage/trailer xenoG/xenoblade-genesis-r.rythmo'
const OUT_DIR = path.join(__dirname, '..', 'website', 'src', 'assets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- build an enriched project: keep video + narrator, add multi-track dialogue ----
function words(phrase, start, end) {
  const parts = phrase.split(' ')
  const totalLen = parts.reduce((s, w) => s + w.length, 0)
  let t = start
  const span = end - start
  return parts.map((w) => {
    const d = (w.length / totalLen) * span
    const o = { text: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }
    t += d
    return o
  })
}
function line(id, characterId, track, phrase, start, end, opts = {}) {
  return { id, characterId, track, entry: opts.entry || 'closed', exit: opts.exit || 'open',
    voiceOff: !!opts.voiceOff, font: null, words: words(phrase, start, end) }
}

function enrich() {
  const p = JSON.parse(fs.readFileSync(SRC_PROJECT, 'utf8'))
  const C = {} // name → id
  for (const c of p.characters) C[c.name] = c.id
  p.tracks = 4
  const added = [
    // window ~14-21 s
    line('add1', C['Professeur Lunette'], 1, 'Regarde ces relevés, c’est impossible', 15.1, 17.2),
    line('add2', C['Le méchant'], 2, 'Rien n’est jamais impossible', 17.5, 18.9, { voiceOff: true }),
    line('add3', C['La soigneuse'], 1, 'Restez groupés, tous', 19.3, 20.7),
    line('add4', C['Mr Kill'], 3, '(souffle)', 16.1, 16.8),
    // window ~26-35 s (dense, colourful)
    line('add5', C['Eleanor'], 1, 'Je ne les laisserai pas faire', 27.0, 29.4),
    line('add6', C['La méchante'], 3, '(rire)', 28.0, 28.9),
    line('add7', C['Mr Dragon'], 2, 'Alors tu périras avec eux', 29.7, 31.9, { voiceOff: true }),
    line('add8', C['Guerrière Arc'], 1, 'Pas tant que je respire', 32.1, 33.9),
    line('add9', C['Jane X doré'], 2, 'En avant, à l’attaque', 33.2, 34.6),
    // ~40 s (frame onglet pistes)
    line('addA', C['Eleanor'], 1, 'Tout a commencé ici', 39.5, 41.5),
    // ~52 s (frame sync — course)
    line('addB', C['Le blond'], 1, 'Ils arrivent, il faut courir', 50.6, 52.6),
    line('addC', C['Guerrière Arc'], 2, 'Ne te retourne pas', 52.0, 53.8),
    line('addD', C['La soigneuse'], 3, '(halète)', 50.9, 51.6),
    // ~66 s (frame plein écran — champ de bataille)
    line('addE', C['Professeur Lunette'], 1, 'Le champ de bataille s’étendait à perte de vue', 64.2, 67.2),
    line('addF', C['Eleanor'], 2, 'Restez en formation', 67.4, 68.8),
    line('addG', C['Mr Dragon'], 3, '(grognement)', 65.4, 66.2, { voiceOff: true }),
    // ~82 s (frame personnages — Eleanor)
    line('addH', C['Eleanor'], 1, 'Je me battrai jusqu’au bout', 80.4, 83.0),
    line('addI', C['Mr Kill'], 2, 'Comme nous tous', 83.2, 84.6),
    line('addJ', C['La méchante'], 3, '(ricane)', 81.0, 81.8),
    // ~100 s (frame scènes — professeur)
    line('addK', C['Professeur Lunette'], 1, 'Les relevés confirment nos craintes', 98.3, 101.0),
    line('addL', C['Professeur combat réel'], 2, 'Alors préparons-nous', 101.2, 102.9, { voiceOff: true }),
    line('addM', C['Jane X doré'], 3, '(soupire)', 99.0, 99.8),
    // ~128 s (frame export) — piste 0 déjà prise par le narrateur d'origine, on remplit les pistes libres
    line('addN', C['Guerrière Arc'], 1, 'À nous de jouer maintenant', 127.0, 129.3),
    line('addO', C['Mr Kill'], 2, '(souffle)', 127.6, 128.3),
  ]
  p.lines = p.lines.concat(added)
  return p
}

async function main() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)))
    }).on('error', reject)
  })
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 128 * 1024 * 1024 })
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  await new Promise((r) => ws.on('open', r))
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const shot = async (name, clip) => {
    const params = { format: 'png' }
    if (clip) params.clip = { ...clip, scale: 1 }
    const s = await send('Page.captureScreenshot', params)
    const out = path.join(OUT_DIR, name)
    fs.writeFileSync(out, Buffer.from(s.data, 'base64'))
    console.log('  saved', name, clip ? `(${Math.round(clip.width)}x${Math.round(clip.height)})` : '(full)')
  }
  const clipOf = (sel) => evaluate(`(() => { const el = document.querySelector('${sel}');
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)

  const project = enrich()
  console.log('loading enriched project:', project.lines.length, 'lines,', project.tracks, 'tracks')
  await evaluate(`loadProjectData(${JSON.stringify(project)}, null)`)

  // wait for the video to be seekable
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate('!!(window.video && video.readyState >= 2 && !isNaN(video.duration))')
    if (ok) break
    await sleep(500)
  }
  const info = await evaluate('({ duration: video.duration, w: video.videoWidth, h: video.videoHeight, lines: project.lines.length })')
  console.log('  video:', JSON.stringify(info))

  const key = async (k, code, vk) => {
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk })
  }
  const playerOpen = () => evaluate('typeof player !== "undefined" && !!player.open')
  const closeExport = () => evaluate("try { if (typeof exp !== 'undefined') exp.open = false; const m = document.getElementById('exportModal'); if (m) m.classList.add('hidden') } catch(e){}")
  const ensureEditor = async () => {
    await evaluate('try { if (typeof player !== "undefined" && player.open) closePlayer() } catch(e){}')
    await closeExport()
    await sleep(500)
    await evaluate("try { document.getElementById('tabRythmo').click() } catch(e){}")
    await sleep(300)
  }
  const seek = async (tc) => { await evaluate('video.pause(); video.currentTime = ' + tc); await sleep(1100) }

  // start clean (a prior run may have left the player open)
  await ensureEditor()

  // HERO (unchanged frame) ~30.5 s
  await seek(30.5)
  await shot('screenshot-main.png')

  // feature 1 — sync, distinct frame ~52 s
  await seek(52)
  await shot('screenshot-sync.png')

  // 2) TRACKS (NLE) tab — crop to the bottom panel (waveform lanes)
  try {
    await evaluate("document.getElementById('tabTracks').click()")
    for (let i = 0; i < 40; i++) { if (await evaluate('typeof wave !== "undefined" && !!wave')) break; await sleep(500) }
    await evaluate('video.currentTime = 40'); await sleep(800)
    console.log('  tracksView visible:', await evaluate("!document.getElementById('tracksView').classList.contains('hidden')"))
    await shot('screenshot-tracks.png', await clipOf('#bottomPanel'))
    await evaluate("document.getElementById('tabRythmo').click()")
    await sleep(400)
  } catch (e) { console.log('  ! tracks err', e.message) }

  // 3) SCENES + PLANS panels open
  try {
    await evaluate("video.currentTime = 100; document.getElementById('btnToggleLoops').click(); document.getElementById('btnTogglePlans').click()")
    await sleep(900)
    await shot('screenshot-scenes.png')
    await evaluate("document.getElementById('btnToggleLoops').click(); document.getElementById('btnTogglePlans').click()")
    await sleep(300)
  } catch (e) { console.log('  ! scenes err', e.message) }

  // 4) CHARACTERS + reaction palette ~82 s
  try {
    await seek(82)
    await evaluate("document.getElementById('btnOnoma').click()")
    await sleep(600)
    await shot('screenshot-characters.png')
    await evaluate("try { const p=document.getElementById('onomaPop'); if(p && !p.classList.contains('hidden')) document.getElementById('btnOnoma').click() } catch(e){}")
    await sleep(300)
  } catch (e) { console.log('  ! characters err', e.message) }

  // 5) EXPORT modal ~128 s
  try {
    await seek(128)
    await evaluate('try { openExportModal() } catch(e){}')
    await sleep(1000)
    await shot('screenshot-export.png')
    await closeExport()
    await sleep(400)
  } catch (e) { console.log('  ! export err', e.message) }

  // 6) FULLSCREEN player LAST (composited band over video)
  try {
    await ensureEditor()
    await evaluate('video.currentTime = 66; try { openPlayer() } catch(e){}')
    await sleep(1800)
    console.log('  player open:', await playerOpen())
    if (await playerOpen()) {
      await shot('screenshot-player.png')
      await evaluate('try { closePlayer() } catch(e){}')
      await sleep(600)
    } else console.log('  ! player did not open')
  } catch (e) { console.log('  ! player err', e.message) }

  ws.close()
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
