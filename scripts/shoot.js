// Dev tool: marketing screenshots for the website. Boots the app under CDP,
// loads two real projects (Xenoblade Genesis enriched with multi-track dialogue,
// Steins Gate 2 with takes for the recording features), captures each section's
// screenshot, then converts everything to WebP (+ og-image.jpg). Run: node scripts/shoot.js
'use strict'
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const PORT = 9222
const ROOT = path.join(__dirname, '..')
const XENO_PROJECT = 'C:/Users/user/OneDrive/Vidéos/doublage/trailer xenoG/xenoblade-genesis-r.rythmo'
const STEINS_PROJECT = 'C:/Users/user/Desktop/steins gate 2.rythmo'
const OUT_DIR = path.join(ROOT, 'website', 'src', 'assets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- projet Xenoblade enrichi : vidéo + narrateur d'origine, dialogues multi-pistes ----
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

function enrichXeno() {
  const p = JSON.parse(fs.readFileSync(XENO_PROJECT, 'utf8'))
  const C = {} // name → id
  for (const c of p.characters) C[c.name] = c.id
  p.tracks = 4
  const added = [
    // fenêtre ~14-21 s
    line('add1', C['Professeur Lunette'], 1, 'Regarde ces relevés, c’est impossible', 15.1, 17.2),
    line('add2', C['Le méchant'], 2, 'Rien n’est jamais impossible', 17.5, 18.9, { voiceOff: true }),
    line('add3', C['La soigneuse'], 1, 'Restez groupés, tous', 19.3, 20.7),
    line('add4', C['Mr Kill'], 3, '(souffle)', 16.1, 16.8),
    // fenêtre ~26-35 s (dense, colorée)
    line('add5', C['Eleanor'], 1, 'Je ne les laisserai pas faire', 27.0, 29.4),
    line('add6', C['La méchante'], 3, '(rire)', 28.0, 28.9),
    line('add7', C['Mr Dragon'], 2, 'Alors tu périras avec eux', 29.7, 31.9, { voiceOff: true }),
    line('add8', C['Guerrière Arc'], 1, 'Pas tant que je respire', 32.1, 33.9),
    line('add9', C['Jane X doré'], 2, 'En avant, à l’attaque', 33.2, 34.6),
    // ~40 s (transcription)
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
  ]
  p.lines = p.lines.concat(added)
  return p
}

async function main() {
  // ---- boot de l'app sous CDP ----
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron', '.', `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, shell: true, stdio: 'ignore' })
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500)
    try {
      const targets = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
          let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)))
        }).on('error', reject)
      })
      page = targets.find((t) => t.type === 'page' && !/detached/.test(t.url))
    } catch {}
  }
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
  // taille de fenêtre constante pour des captures homogènes
  try {
    const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.id })
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', left: 20, top: 20, width: 1680, height: 960 } })
  } catch (e) { console.log('  ! resize err', e.message) }
  await sleep(1500)

  const pngs = []
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'))
    pngs.push(name)
    console.log('  saved', name)
  }
  const waitVideo = async () => {
    for (let i = 0; i < 60; i++) {
      if (await evaluate('!!(window.video && video.readyState >= 2 && !isNaN(video.duration))')) return
      await sleep(500)
    }
    throw new Error('video not ready')
  }
  const seek = async (tc) => { await evaluate('video.pause(); video.currentTime = ' + tc); await sleep(1100) }
  const ensureEditor = async () => {
    await evaluate('try { if (typeof player !== "undefined" && player.open) closePlayer() } catch(e){}')
    await evaluate("try { if (typeof exp !== 'undefined') exp.open = false; document.getElementById('exportModal').classList.add('hidden') } catch(e){}")
    await sleep(400)
    await evaluate("try { document.getElementById('tabRythmo').click() } catch(e){}")
    await sleep(300)
  }

  // ================= phase A : Xenoblade Genesis (éditeur) =================
  const xeno = enrichXeno()
  console.log('xenoblade:', xeno.lines.length, 'lines,', xeno.tracks, 'tracks')
  await evaluate(`loadProjectData(${JSON.stringify(xeno)}, null)`)
  await waitVideo()
  await ensureEditor()

  // HERO ~30.5 s (bande dense multi-pistes)
  await seek(30.5)
  await shot('screenshot-main.png')

  // sync ~52 s (course)
  await seek(52)
  await shot('screenshot-sync.png')

  // personnages + palette de réacs ~82 s
  await seek(82)
  await evaluate("document.getElementById('btnOnoma').click()")
  await sleep(600)
  await shot('screenshot-characters.png')
  await evaluate("try { const p=document.getElementById('onomaPop'); if(p && !p.classList.contains('hidden')) document.getElementById('btnOnoma').click() } catch(e){}")

  // scènes + plans ~100 s
  await evaluate("video.currentTime = 100; document.getElementById('btnToggleLoops').click(); document.getElementById('btnTogglePlans').click()")
  await sleep(900)
  await shot('screenshot-scenes.png')
  await evaluate("document.getElementById('btnToggleLoops').click(); document.getElementById('btnTogglePlans').click()")
  await sleep(300)

  // transcription assistée ~40 s (modale, moteur + modèles déjà installés sur la machine)
  try {
    await seek(40)
    await evaluate('try { openTranscribeDialog() } catch(e){}')
    await sleep(1400)
    await shot('screenshot-transcribe.png')
    await evaluate("try { document.getElementById('transcribeModal').classList.add('hidden') } catch(e){}")
    await sleep(300)
  } catch (e) { console.log('  ! transcribe err', e.message) }

  // plein écran ~66 s (champ de bataille)
  await evaluate('video.currentTime = 66; try { openPlayer() } catch(e){}')
  await sleep(1800)
  if (await evaluate('typeof player !== "undefined" && !!player.open')) {
    await shot('screenshot-player.png')
    await evaluate('try { closePlayer() } catch(e){}')
    await sleep(600)
  } else console.log('  ! player did not open')

  // ================= phase B : Steins Gate 2 (enregistrement) =================
  await ensureEditor()
  console.log('loading steins gate 2…')
  await evaluate(`(async () => {
    const r = await window.api.openProjectPath(${JSON.stringify(STEINS_PROJECT)})
    loadProjectData(JSON.parse(r.data), r.path)
  })()`)
  await waitVideo()
  // enrichit les prises : la vraie prise (95 s) est découpée en segments pour montrer
  // plusieurs takes par personnage, dont une alternative empilée (take 2 retenue)
  await evaluate(`(() => {
    const ok = project.characters.find((c) => c.name === 'Okabe').id
    const ku = project.characters.find((c) => c.name === 'Kurisu').id
    const F = 'rec_nu4n7ciq_7absz0fl.webm', FX = 'fx_rec_nu4n7ciq_7absz0fl.wav', D = 95.46
    const seg = (id, ch, startTime, srcOff, len, lane, active) => ({ id, characterId: ch, file: F, startTime,
      dur: D, trimStart: srcOff, trimEnd: Math.max(0, D - srcOff - len), lane, active: active !== false, fxFile: FX })
    project.recordings = [
      seg('s1', ok, 12.2, 5, 6.5, 0),
      seg('s2', ok, 21.0, 14, 5.2, 0, false), // 1re take, remplacée
      seg('s3', ok, 22.4, 30, 4.4, 1),        // take 2 retenue, empilée
      seg('s4', ok, 30.8, 44, 7.0, 0),
      seg('s5', ku, 18.6, 60, 3.8, 0),
      seg('s6', ku, 27.5, 70, 5.5, 0),
    ]
    project.recMuted = []
    selectedCharId = ok
  })()`)
  // onglet Enregistrement, dialogue visible sur la bande ~24 s
  await evaluate("document.getElementById('tabRec').click()")
  await sleep(1200)
  await seek(24)
  await sleep(2200) // formes d'onde des prises
  await shot('screenshot-recording.png')

  // voix par personnage : onglet Audio, Kurisu coupée, popover ouvert
  await evaluate("document.getElementById('tabTracks').click()")
  await sleep(900)
  await evaluate(`(() => {
    const ku = project.characters.find((c) => c.name === 'Kurisu').id
    project.muteChars = [ku]
  })()`)
  await seek(30)
  await evaluate("document.getElementById('btnDub').click()")
  await sleep(700)
  await shot('screenshot-voice.png')
  await evaluate("try { document.getElementById('dubPop').classList.add('hidden') } catch(e){}")

  // export : modale compacte avec la rangée Enregistrements + FX
  await evaluate("document.getElementById('tabRythmo').click()")
  await sleep(400)
  await seek(55)
  await evaluate('try { openExportModal() } catch(e){}')
  await sleep(1400)
  await shot('screenshot-export.png')

  ws.close()
  spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { shell: true })
  await sleep(1000)

  // ================= conversion WebP + og-image =================
  const ffmpeg = require('ffmpeg-static')
  for (const png of pngs) {
    const webp = png.replace(/\.png$/, '.webp')
    const r = spawnSync(ffmpeg, ['-y', '-i', path.join(OUT_DIR, png), '-c:v', 'libwebp', '-quality', '82', path.join(OUT_DIR, webp)], { stdio: 'ignore' })
    console.log(r.status === 0 ? '  webp ' + webp : '  ! webp FAIL ' + webp)
  }
  const og = spawnSync(ffmpeg, ['-y', '-i', path.join(OUT_DIR, 'screenshot-main.png'), '-vf', 'scale=1200:-2,crop=1200:630', '-q:v', '3', path.join(OUT_DIR, 'og-image.jpg')], { stdio: 'ignore' })
  console.log(og.status === 0 ? '  og-image.jpg' : '  ! og-image FAIL')
  for (const png of pngs) fs.unlinkSync(path.join(OUT_DIR, png))
  console.log('done:', pngs.length, 'screenshots')
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
