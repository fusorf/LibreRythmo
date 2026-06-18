'use strict'

// ============================================================ helpers
const $ = (id) => document.getElementById(id)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const uid = () => Math.random().toString(36).slice(2, 10)

// Palette d'auto-attribution (v1.1) : encres sombres et saturées, lisibles aussi
// bien sur fond clair (convention papier du doublage) que sur le thème sombre. Les
// couleurs vives/fluo sont réservées aux petits rôles, ambiances et voix médias
// (l'utilisateur les choisit à la main via le sélecteur de couleur).
const PALETTE = ['#c0392b', '#2e6da4', '#2a8c6a', '#8e44ad', '#c2790f', '#1f7a8c', '#b03a5b', '#4a5a99']
const MAX_TRACKS = 4 // plafond DETX (track 0-3) = capacité maximale
const DEFAULT_TRACKS = 1 // nombre de pistes affichées par défaut
const RULER_H = 30 // hauteur de la règle de temps (un peu plus épaisse que le texte)

// nombre de lanes affichées (1..MAX_TRACKS) ; pilote la hauteur de chaque piste
const laneCount = () => clamp(project.tracks || DEFAULT_TRACKS, 1, MAX_TRACKS)
// nombre de pistes réellement peuplées = minimum sélectionnable dans le menu Pistes
const populatedCount = () => new Set(project.lines.map((l) => l.track)).size
const READ_RATIO = 0.3 // point de lecture à 30 % de la largeur

function formatTc(t, fps) {
  if (!isFinite(t) || t < 0) t = 0
  const f = Math.floor((t % 1) * fps)
  const s = Math.floor(t)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}:${String(f).padStart(2, '0')}`
}

// timecode compact pour les listes : M:SS (H:MM:SS au-delà d'une heure)
function formatTcShort(t) {
  if (!isFinite(t) || t < 0) t = 0
  const s = Math.floor(t)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function parseTc(str, fps) {
  if (!str) return null
  const parts = str.trim().split(':').map((p) => p.replace(',', '.'))
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null
  const n = parts.map(Number)
  if (n.length === 1) return n[0]
  if (n.length === 2) return n[0] * 60 + n[1]
  if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2]
  if (n.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / fps
  return null
}

function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200)
}

// notification de mise à jour : toast discret cliquable (ouvre la page Releases),
// disparaît seul après 10 s — aucune autre interruption
window.api.onUpdateAvailable((v) => {
  const el = $('toast')
  el.textContent = t('updateAvailable', v)
  el.classList.add('clickable')
  el.classList.remove('hidden')
  el.onclick = () => {
    window.api.openReleases()
    el.classList.add('hidden')
  }
  clearTimeout(toast._t)
  toast._t = setTimeout(() => {
    el.classList.add('hidden')
    el.classList.remove('clickable')
    el.onclick = null
  }, 10000)
})

// overlay de chargement bloquant (affiché pendant le chargement d'une vidéo)
function showLoading(on, text) {
  clearTimeout(showLoading._t)
  const el = $('loadingOverlay')
  if (on) {
    $('loadingText').textContent = text || t('loadingVideo')
    el.classList.remove('hidden')
    showLoading._t = setTimeout(() => el.classList.add('hidden'), 20000) // garde-fou
  } else {
    el.classList.add('hidden')
  }
}

// ============================================================ state
function newProject() {
  return { version: 1, videoPath: null, fps: 25, tracks: DEFAULT_TRACKS, characters: [], lines: [], loops: [], audioTracks: [] }
}

// Boucles (= scènes, unité de travail à l'enregistrement). Durées de référence du
// doublage FR : on alerte au-delà de ~50 s pour une boucle normale, et en deçà de
// 30 s pour un segment OUT (qui doit rester long et d'un seul tenant).
const LOOP_WARN_SEC = 50
const LOOP_OUT_MIN_SEC = 30
const LOOP_DEFAULT_SEC = 40 // longueur par défaut d'une nouvelle boucle

let project = newProject()
let projectPath = null
let dirty = false
let selectedCharId = null
let selectedIds = new Set() // sélection multiple ; l'inspecteur n'apparaît que pour 1 réplique
const singleSelected = () => (selectedIds.size === 1 ? getLine([...selectedIds][0]) : null)
// Zoom exprimé en SECONDES VISIBLES sur la largeur de la bande ; pxPerSec en découle
// (recomputePps) selon la largeur courante. Dézoom max = 10 s, défaut = 5 s, zoom max = 1 s.
let secondsVisible = 5
const SEC_MAX = 10 // dézoomé au maximum
const SEC_MIN = 3 // zoomé au maximum
let pxPerSec = 120
function recomputePps() {
  if (cw > 0) pxPerSec = cw / clamp(secondsVisible, SEC_MIN, SEC_MAX)
}

// Hauteur de piste FIXE : une piste a toujours la même hauteur. Moins de pistes =
// bande plus courte en bas (la vidéo récupère la place).
const LANE_H = 76
const bandHeightFor = (n) => Math.round(RULER_H + n * LANE_H)

function applyBandHeight() {
  const h = bandHeightFor(laneCount())
  canvas.style.flex = `0 0 ${h}px`
  canvas.style.height = `${h}px`
  resizeCanvas() // met à jour cw/ch immédiatement
}

const video = $('video')
const canvas = $('band')
const ctx = canvas.getContext('2d')

// ---------- thème sombre / clair (Affichage → Mode clair) ----------
// La bande est rendue au canvas : chaque thème a sa propre palette, aussi
// utilisée par l'export (sélecteur « Thème de la bande »).
const BAND_THEMES = {
  dark: {
    bg: '#101114', lane: '#17181d', grid: '#23242b',
    rulerBg: '#0c0d10', tick: '#3a3c45', tickText: '#6c6f78',
    wave: 'rgba(122, 162, 255, 0.13)', playhead: '#e8443a',
    handle: '#ffffff', handleAccent: '#7aa2ff', selStroke: '#ffffffcc',
    markIn: '#5fbf6a', markOut: '#e8584a', // flèches d'entrée (vert) / sortie (rouge)
  },
  light: {
    bg: '#f6f2e9', lane: '#ece6d8', grid: '#d8d1c0',
    rulerBg: '#e9e3d4', tick: '#a59d89', tickText: '#7c7565',
    wave: 'rgba(58, 94, 190, 0.15)', playhead: '#d23a30',
    handle: '#2b2a25', handleAccent: '#3c5d96', selStroke: '#2b2a25cc',
    markIn: '#2f9e44', markOut: '#d23a30',
  },
}
let theme = 'dark'
const bandPal = () => BAND_THEMES[theme]

function setTheme(th) {
  theme = th === 'light' ? 'light' : 'dark'
  document.body.classList.toggle('light', theme === 'light')
}

let exportEncoder = 'gpu' // préférence persistée ([export] encoder dans settings.ini)

// pousse tous les réglages au process principal : persistance settings.ini + menu
function pushSettings() {
  window.api.setLang({ lang, theme, wave: showWave, info: showVideoInfo, autosave: autosaveOn, encoder: exportEncoder })
}

function markDirty() {
  if (!dirty) window.api.setDirty(true)
  dirty = true
  updateTitle()
  scheduleAutosave()
  scheduleLinesLog()
}

function setClean() {
  dirty = false
  updateTitle()
  window.api.setDirty(false)
}

function updateTitle() {
  const name = projectPath ? projectPath.replace(/^.*[\\/]/, '') : t('untitled')
  const auto = autosaveOn ? `  [${t('autosaveTag')}]` : ''
  document.title = `LibreRythmo — ${name}${dirty ? ' •' : ''}${auto}`
}

// ---------- enregistrement automatique (Fichier → Enregistrement automatique)
let autosaveOn = false // initialisé depuis settings.ini

function scheduleAutosave() {
  if (!autosaveOn || !projectPath) return
  clearTimeout(scheduleAutosave._t)
  scheduleAutosave._t = setTimeout(async () => {
    if (!autosaveOn || !projectPath || !dirty || exp.running) return
    const p = await window.api.saveProject(JSON.stringify(project, null, 2), projectPath)
    if (p) setClean()
  }, 1500)
}

// ---------- annuler / rétablir (10 étapes, instantanés JSON du contenu)
const UNDO_MAX = 10
let undoStack = []
let redoStack = []
let undoCoalesce = false // les pushUndo d'une même opération (même tick) ne comptent qu'une fois

const undoSnap = () => JSON.stringify({ tracks: project.tracks, characters: project.characters, lines: project.lines, loops: project.loops, audioTracks: project.audioTracks })

function pushUndo() {
  if (undoCoalesce) return
  undoCoalesce = true
  queueMicrotask(() => { undoCoalesce = false })
  undoStack.push(undoSnap())
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack.length = 0
  syncUndoMenu()
}

// griser Annuler / Rétablir dans le menu Édition selon l'état des piles
let lastUndoState = ''
function syncUndoMenu() {
  const st = { undo: undoStack.length > 0, redo: redoStack.length > 0 }
  const k = `${st.undo}|${st.redo}`
  if (k === lastUndoState) return
  lastUndoState = k
  window.api.setUndoState(st)
}

function restoreState(snap) {
  const d = JSON.parse(snap)
  if (d.tracks) project.tracks = d.tracks
  project.characters = d.characters
  project.lines = d.lines
  project.loops = d.loops || []
  if (d.audioTracks) project.audioTracks = d.audioTracks
  if (!getChar(selectedCharId)) selectedCharId = project.characters[0]?.id || null
  selectedIds = new Set([...selectedIds].filter((id) => getLine(id)))
  renderChars()
  applyBandHeight()
  buildInsTrackOptions()
  buildLineFilterOptions()
  refreshInspector()
  refreshTrackCountUI()
  renderLoopsPanel()
  if (activeTab === 'tracks') renderTracks()
  markDirty()
}

function undo() {
  if (!undoStack.length) return
  redoStack.push(undoSnap())
  restoreState(undoStack.pop())
  syncUndoMenu()
}

function redo() {
  if (!redoStack.length) return
  undoStack.push(undoSnap())
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  restoreState(redoStack.pop())
  syncUndoMenu()
}

// applique la langue courante à toute l'interface statique
function applyLang() {
  document.documentElement.lang = lang
  $('dropHintMain').textContent = t('dropMain')
  $('dropHintSub').textContent = t('dropSub')

  // transport
  $('tStart').title = t('tStart')
  $('tFrameB').title = t('tFrameB')
  $('tPlay').title = t('tPlay')
  $('tFrameF').title = t('tFrameF')
  $('timecode').title = t('timecode')
  $('speed').title = t('speed')
  document.querySelector('.vol').title = t('volume')
  $('addLineLabel').textContent = t('addLine')
  $('btnAddLine').title = t('addLineTitle')
  $('btnOnoma').textContent = t('onomaBtn')
  $('btnOnoma').title = t('onomaTitle')
  $('btnMagnet').title = t('magnetTitle')
  buildOnomaPop()
  $('btnTogglePanel').textContent = t('panelToggle')
  $('btnTogglePanel').title = t('panelToggleTitle')
  $('btnToggleLines').textContent = t('linesTitle')
  $('btnToggleLines').title = t('linesToggleTitle')
  $('btnToggleLoops').textContent = t('loopsTitle')
  $('btnToggleLoops').title = t('loopsToggleTitle')
  $('loopsTitle').textContent = t('loopsTitle')
  $('btnAddLoop').textContent = t('addLoop')
  $('btnAddLoop').title = t('addLoopTitle')
  $('btnLoopPrev').title = t('loopPrevTitle')
  $('btnLoopNext').title = t('loopNextTitle')
  $('loopsEmpty').textContent = t('loopsEmpty')
  renderLoopsPanel()
  // onglets + vue Pistes
  $('tabRythmo').textContent = t('tabRythmo')
  $('tabTracks').textContent = t('tabTracks')
  $('btnImportAudio').textContent = t('importAudio')
  $('shiftLabel').textContent = t('shiftLabel')
  $('shiftUnit').textContent = t('shiftUnit')
  $('btnShiftApply').textContent = t('shiftApply')
  if (activeTab === 'tracks') renderTracks()
  $('zoomWrap').title = t('zoomTitle')
  $('trackCount').title = t('trackCountTitle')
  refreshTrackCountUI()
  $('lineFilter').title = t('filterTitle')
  $('lineSearch').placeholder = t('lineSearchPh')
  buildLineFilterOptions()

  // panneau personnages + log des répliques
  $('panelTitle').textContent = t('panelTitle')
  $('btnAddChar').textContent = t('addChar')
  $('linesTitle').textContent = t('linesTitle')
  buildGuide()

  // inspecteur
  $('insEmpty').textContent = t('insEmpty')
  ins.char.title = t('insChar')
  ins.track.title = t('insTrack')
  buildInsTrackOptions()

  // entrée / sortie (bouche ouverte / fermée) — options reconstruites pour la langue
  for (const [sel, side] of [[ins.entry, 'entry'], [ins.exit, 'exit']]) {
    sel.title = t(side === 'entry' ? 'insEntry' : 'insExit')
    const prev = sel.value
    sel.innerHTML = ''
    for (const [val, key] of [['', 'mouthNone'], ['open', 'mouthOpen'], ['closed', 'mouthClosed']]) {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = t(key, side)
      sel.appendChild(opt)
    }
    sel.value = prev
  }

  ins.voiceOff.textContent = t('insVoiceOff')
  ins.voiceOff.title = t('insVoiceOffTitle')
  ins.text.placeholder = t('insTextPh')
  ins.start.title = t('insStart')
  ins.end.title = t('insEnd')
  $('insDel').textContent = t('insDel')
  $('insDel').title = t('insDelTitle')

  // export
  $('expTitle').textContent = t('expTitle')
  $('lblRes').textContent = t('lblRes')
  $('optCustom').textContent = t('optCustom')
  $('lblFps').textContent = t('lblFps')
  $('lblTheme').textContent = t('lblTheme')
  $('optThemeDark').textContent = t('optThemeDark')
  $('optThemeLight').textContent = t('optThemeLight')
  $('grpOutput').textContent = t('grpOutput')
  $('grpBand').textContent = t('grpBand')
  $('grpContent').textContent = t('grpContent')
  $('lblExpTracks').textContent = t('lblExpTracks')
  $('lblExpLoops').textContent = t('lblExpLoops')
  $('lblExpAudio').textContent = t('lblExpAudio')
  $('lblBandPos').textContent = t('lblBandPos')
  $('optBandBottom').textContent = t('optBandBottom')
  $('optBandTop').textContent = t('optBandTop')
  $('lblEnc').textContent = t('lblEnc')
  $('lblSpeed').textContent = t('lblSpeed')
  $('lblSpeedWrap').title = t('speedTitle')
  $('expReset').textContent = t('expReset')
  $('lblDest').textContent = t('lblDest')
  $('expPath').placeholder = t('expPathPh')
  $('expBrowse').textContent = t('expBrowse')
  $('expGo').textContent = t('expGo')
  if (!exp.running) $('expClose').textContent = t('close')
  updateWinReadout()

  renderChars()
  refreshInspector()
  renderLinesLog()
  updateVideoInfoPanel()
  updateTitle()
}

function setLanguage(l) {
  lang = l
  applyLang()
  pushSettings()
}

const getChar = (id) => project.characters.find((c) => c.id === id) || null
const getLine = (id) => project.lines.find((l) => l.id === id) || null
const lineStart = (l) => (l.words.length ? l.words[0].start : 0)
const lineEnd = (l) => (l.words.length ? l.words[l.words.length - 1].end : 0)
const videoDur = () => (isFinite(video.duration) ? video.duration : 1e9)

// ============================================================ characters
function addCharacter(name) {
  pushUndo()
  const c = {
    id: uid(),
    name: name || t('defaultChar', project.characters.length + 1),
    color: PALETTE[project.characters.length % PALETTE.length],
  }
  project.characters.push(c)
  selectedCharId = c.id
  renderChars()
  refreshInspector()
  markDirty()
  return c
}

function renderChars() {
  // pastille du personnage sélectionné sur le bouton « + Nouvelle réplique »
  const sel = getChar(selectedCharId)
  $('addLineDot').classList.toggle('hidden', !sel)
  if (sel) $('addLineDot').style.background = sel.color

  const list = $('charList')
  list.innerHTML = ''
  for (const c of project.characters) {
    const row = document.createElement('div')
    row.className = 'char-row' + (c.id === selectedCharId ? ' selected' : '')
    row.dataset.id = c.id

    const sw = document.createElement('input')
    sw.type = 'color'
    sw.value = c.color
    sw.title = t('charColor')
    sw.addEventListener('input', () => {
      if (!sw.dataset.pushed) { pushUndo(); sw.dataset.pushed = '1' }
      c.color = sw.value
      if (c.id === selectedCharId) $('addLineDot').style.background = c.color
      markDirty()
    })
    sw.addEventListener('change', () => { delete sw.dataset.pushed })
    sw.addEventListener('click', (e) => e.stopPropagation())

    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = c.name

    const edit = document.createElement('button')
    edit.className = 'edit'
    edit.textContent = '✎'
    edit.title = t('charRename')
    edit.addEventListener('click', (e) => {
      e.stopPropagation()
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.className = 'nm-input'
      inp.value = c.name
      inp.spellcheck = false
      nm.replaceWith(inp)
      inp.focus()
      inp.select()
      let cancelled = false
      const done = () => {
        const nv = inp.value.trim()
        if (!cancelled && nv && nv !== c.name) {
          pushUndo()
          c.name = nv
          markDirty()
        }
        renderChars()
        refreshInspector()
      }
      inp.addEventListener('blur', done)
      inp.addEventListener('click', (ev) => ev.stopPropagation())
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') inp.blur()
        if (ev.key === 'Escape') { cancelled = true; inp.blur() }
        ev.stopPropagation()
      })
    })

    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = '✕'
    x.title = t('charDelete')
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      pushUndo()
      project.characters = project.characters.filter((k) => k.id !== c.id)
      if (selectedCharId === c.id) selectedCharId = project.characters[0]?.id || null
      renderChars()
      refreshInspector()
      markDirty()
    })

    row.append(sw, nm, edit, x)
    row.addEventListener('click', () => {
      selectedCharId = c.id
      renderChars()
    })
    list.appendChild(row)
  }
}

$('btnTogglePanel').addEventListener('click', () => {
  const panel = $('sidePanel')
  panel.classList.toggle('hidden')
  $('btnTogglePanel').classList.toggle('active', !panel.classList.contains('hidden'))
})

$('btnToggleLines').addEventListener('click', () => {
  const panel = $('linesPanel')
  panel.classList.toggle('hidden')
  $('btnToggleLines').classList.toggle('active', !panel.classList.contains('hidden'))
})

$('btnToggleLoops').addEventListener('click', () => {
  const panel = $('loopsPanel')
  panel.classList.toggle('hidden')
  $('btnToggleLoops').classList.toggle('active', !panel.classList.contains('hidden'))
})

$('btnAddLoop').addEventListener('click', addLoopAtPlayhead)
$('btnLoopPrev').addEventListener('click', () => gotoLoop(-1))
$('btnLoopNext').addEventListener('click', () => gotoLoop(1))

$('btnAddChar').addEventListener('click', () => {
  addCharacter()
  refreshInspector()
})

// ============================================================ lines
function splitWords(text, start, end) {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) tokens.push('…')
  const weights = tokens.map((t) => t.length + 1)
  const total = weights.reduce((a, b) => a + b, 0)
  const dur = Math.max(0.1, end - start)
  const words = []
  let t = start
  for (let i = 0; i < tokens.length; i++) {
    const w = (weights[i] / total) * dur
    words.push({ text: tokens[i], start: t, end: i === tokens.length - 1 ? end : t + w })
    t += w
  }
  return words
}

function findFreeTrack(start, end) {
  for (let tr = 0; tr < laneCount(); tr++) {
    const busy = project.lines.some(
      (l) => l.track === tr && lineStart(l) < end && lineEnd(l) > start
    )
    if (!busy) return tr
  }
  return 0
}

function addLineAt(start, track, text, dur) {
  pushUndo()
  if (!project.characters.length) addCharacter()
  start = Math.max(0, start)
  const end = start + (dur || 2)
  const line = {
    id: uid(),
    characterId: selectedCharId || project.characters[0].id,
    track: track == null ? findFreeTrack(start, end) : track,
    words: splitWords(text || '…', start, end),
  }
  project.lines.push(line)
  selectedIds = new Set([line.id])
  refreshInspector()
  markDirty()
  return line
}

function deleteSelected() {
  if (!selectedIds.size) return
  pushUndo()
  project.lines = project.lines.filter((l) => !selectedIds.has(l.id))
  selectedIds.clear()
  refreshInspector()
  markDirty()
}

// ---------- copier / coller de répliques (calage par mot + bornes conservés) ----------
// Le presse-papier garde des copies profondes, ramenées à t=0 (la plus précoce des
// répliques copiées) ; le collage replace ce groupe au point de lecture en
// préservant les écarts relatifs entre répliques et l'élongation interne.
let lineClipboard = null // { base: number, lines: [{characterId, track, entry, exit, voiceOff, kind, words}] }

function copyLines() {
  const sel = project.lines.filter((l) => selectedIds.has(l.id) && l.words.length)
  if (!sel.length) return
  const base = Math.min(...sel.map(lineStart))
  lineClipboard = {
    base,
    lines: sel.map((l) => ({
      characterId: l.characterId,
      track: l.track,
      entry: l.entry,
      exit: l.exit,
      voiceOff: l.voiceOff,
      kind: l.kind,
      words: l.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    })),
  }
  toast(t('linesCopied', sel.length))
}

function pasteLines() {
  if (!lineClipboard || !lineClipboard.lines.length) return
  pushUndo()
  if (!project.characters.length) addCharacter()
  const offset = Math.max(0, effectiveTime()) - lineClipboard.base
  const fallbackChar = selectedCharId || project.characters[0].id
  const pasted = []
  for (const src of lineClipboard.lines) {
    const line = {
      id: uid(),
      characterId: getChar(src.characterId) ? src.characterId : fallbackChar,
      track: clamp(src.track || 0, 0, laneCount() - 1),
      words: src.words.map((w) => ({ text: w.text, start: Math.max(0, w.start + offset), end: Math.max(0, w.end + offset) })),
    }
    if (src.entry) line.entry = src.entry
    if (src.exit) line.exit = src.exit
    if (src.voiceOff) line.voiceOff = true
    if (src.kind) line.kind = src.kind
    project.lines.push(line)
    pasted.push(line.id)
  }
  selectedIds = new Set(pasted)
  refreshInspector()
  markDirty()
  toast(t('linesPasted', pasted.length))
}

function shiftLine(line, dt) {
  const s = lineStart(line)
  if (s + dt < 0) dt = -s
  for (const w of line.words) {
    w.start += dt
    w.end += dt
  }
}

function rescaleLine(line, newEnd) {
  const s = lineStart(line)
  const e = lineEnd(line)
  if (newEnd <= s + 0.1 || e <= s) return
  const k = (newEnd - s) / (e - s)
  for (const w of line.words) {
    w.start = s + (w.start - s) * k
    w.end = s + (w.end - s) * k
  }
}

// ============================================================ inspector
const ins = {
  el: $('inspector'),
  char: $('insChar'),
  track: $('insTrack'),
  entry: $('insEntry'),
  exit: $('insExit'),
  voiceOff: $('insVoiceOff'),
  text: $('insText'),
  start: $('insStart'),
  end: $('insEnd'),
}

function refreshInspector() {
  const line = singleSelected()
  ins.el.classList.toggle('empty', !line)
  scheduleLinesLog()
  if (!line) {
    $('insEmpty').textContent = selectedIds.size > 1 ? t('multiSelected', selectedIds.size) : t('insEmpty')
    return
  }
  ins.char.innerHTML = ''
  for (const c of project.characters) {
    const o = document.createElement('option')
    o.value = c.id
    o.textContent = c.name
    ins.char.appendChild(o)
  }
  ins.char.value = line.characterId
  ins.track.value = String(line.track)
  ins.entry.value = line.entry || ''
  ins.exit.value = line.exit || ''
  ins.voiceOff.classList.toggle('active', !!line.voiceOff)
  if (document.activeElement !== ins.text) ins.text.value = line.words.map((w) => w.text).join(' ')
  if (document.activeElement !== ins.start) ins.start.value = formatTc(lineStart(line), project.fps)
  if (document.activeElement !== ins.end) ins.end.value = formatTc(lineEnd(line), project.fps)
}

ins.char.addEventListener('change', () => {
  const l = singleSelected()
  if (l) { pushUndo(); l.characterId = ins.char.value; markDirty() }
})
ins.track.addEventListener('change', () => {
  const l = singleSelected()
  if (l) { pushUndo(); l.track = Number(ins.track.value); markDirty() }
})
ins.entry.addEventListener('change', () => {
  const l = singleSelected()
  if (l) { pushUndo(); l.entry = ins.entry.value || undefined; markDirty() }
})
ins.exit.addEventListener('change', () => {
  const l = singleSelected()
  if (l) { pushUndo(); l.exit = ins.exit.value || undefined; markDirty() }
})
// voix off : bouche non visible à l'écran → texte souligné sur la bande
ins.voiceOff.addEventListener('click', () => {
  const l = singleSelected()
  if (!l) return
  pushUndo()
  l.voiceOff = !l.voiceOff
  if (!l.voiceOff) delete l.voiceOff
  refreshInspector()
  markDirty()
})
let insTextPushed = false // une étape d'annulation par session d'édition du texte
ins.text.addEventListener('focus', () => { insTextPushed = false })
ins.text.addEventListener('input', () => {
  const l = singleSelected()
  if (!l) return
  if (!insTextPushed) { pushUndo(); insTextPushed = true }
  l.words = splitWords(ins.text.value, lineStart(l), lineEnd(l))
  markDirty()
})
ins.start.addEventListener('change', () => {
  const l = singleSelected()
  const t = parseTc(ins.start.value, project.fps)
  if (l && t != null) { pushUndo(); shiftLine(l, t - lineStart(l)); markDirty() }
  refreshInspector()
})
ins.end.addEventListener('change', () => {
  const l = singleSelected()
  const t = parseTc(ins.end.value, project.fps)
  if (l && t != null) { pushUndo(); rescaleLine(l, t); markDirty() }
  refreshInspector()
})
$('insDel').addEventListener('click', deleteSelected)

// ============================================================ nombre de pistes
// 2 lanes par défaut, réglable de 1 à MAX_TRACKS via le menu « Pistes ». On ne
// peut pas descendre sous le nombre de pistes peuplées ; réduire compacte les
// indices pour retirer les pistes vides (où qu'elles soient).

// options « Piste 1..N » de l'inspecteur, alignées sur le nombre de lanes affichées
function buildInsTrackOptions() {
  const prev = ins.track.value
  ins.track.innerHTML = ''
  for (let i = 0; i < laneCount(); i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = t('track', i + 1)
    ins.track.appendChild(opt)
  }
  ins.track.value = Number(prev) < laneCount() ? prev : '0'
}

// menu « Pistes » de la barre de transport : options 1..MAX, grisées sous le
// nombre de pistes peuplées ; valeur courante = nombre de lanes affichées
function refreshTrackCountUI() {
  const sel = $('trackCount')
  if (!sel) return
  const min = populatedCount() || 1
  sel.innerHTML = ''
  for (let i = 1; i <= MAX_TRACKS; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = t('trackCountOpt', i)
    if (i < min) opt.disabled = true
    sel.appendChild(opt)
  }
  sel.value = String(laneCount())
}

// compacte les indices de piste pour tenir dans n lanes : les pistes peuplées
// (triées) sont réassignées à 0,1,2… — ne s'active que si une réplique déborde
function compactTracksToFit(n) {
  const used = [...new Set(project.lines.map((l) => l.track))].sort((a, b) => a - b)
  if (used.length && used[used.length - 1] >= n) {
    const map = new Map(used.map((tr, i) => [tr, i]))
    for (const l of project.lines) l.track = map.get(l.track)
  }
}

function setTrackCount(n) {
  n = clamp(n, populatedCount() || 1, MAX_TRACKS)
  if (n === laneCount()) { refreshTrackCountUI(); return }
  pushUndo()
  compactTracksToFit(n)
  project.tracks = n
  applyBandHeight() // moins/plus de pistes → bande plus courte/haute, piste à hauteur fixe
  buildInsTrackOptions()
  buildLineFilterOptions()
  refreshInspector()
  refreshTrackCountUI()
  renderLinesLog()
  markDirty()
}

$('trackCount').addEventListener('change', (e) => setTrackCount(Number(e.target.value)))

// ============================================================ lines log (side panel)
// Liste chronologique de toutes les répliques ; clic = sauter au début de la réplique.
let lastLogSel = ''
let lineFilterTrack = null // null = toutes les pistes ; sinon index de piste filtré
let lineSearchQuery = '' // recherche texte dans la liste des répliques (Ctrl+F)

// options du filtre par piste : « Toutes » + une entrée par lane affichée
function buildLineFilterOptions() {
  const sel = $('lineFilter')
  sel.innerHTML = ''
  const all = document.createElement('option')
  all.value = 'all'
  all.textContent = t('filterAll')
  sel.appendChild(all)
  for (let i = 0; i < laneCount(); i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = t('track', i + 1)
    sel.appendChild(opt)
  }
  // si la piste filtrée n'existe plus (lanes réduites), revenir à « Toutes »
  if (lineFilterTrack != null && lineFilterTrack >= laneCount()) lineFilterTrack = null
  sel.value = lineFilterTrack == null ? 'all' : String(lineFilterTrack)
}

$('lineFilter').addEventListener('change', (e) => {
  lineFilterTrack = e.target.value === 'all' ? null : Number(e.target.value)
  renderLinesLog()
})

$('lineSearch').addEventListener('input', (e) => {
  lineSearchQuery = e.target.value.trim().toLowerCase()
  renderLinesLog()
})

// Ctrl+F : ouvre le panneau Répliques s'il est fermé, remet le filtre sur toutes
// les pistes, et place le focus dans le champ de recherche
function openLineSearch() {
  const panel = $('linesPanel')
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden')
    $('btnToggleLines').classList.add('active')
  }
  if (lineFilterTrack != null) {
    lineFilterTrack = null
    $('lineFilter').value = 'all'
    renderLinesLog()
  }
  const inp = $('lineSearch')
  inp.focus()
  inp.select()
}

function scheduleLinesLog() {
  if (scheduleLinesLog._t) return
  scheduleLinesLog._t = setTimeout(() => {
    scheduleLinesLog._t = 0
    renderLinesLog()
  }, 200)
}

function renderLinesLog() {
  refreshTrackCountUI() // le minimum sélectionnable suit le nombre de pistes peuplées
  const log = $('linesLog')
  log.innerHTML = ''
  const q = lineSearchQuery
  const sorted = [...project.lines]
    .filter((l) => lineFilterTrack == null || l.track === lineFilterTrack)
    .filter((l) => !q || l.words.map((w) => w.text).join(' ').toLowerCase().includes(q) || (getChar(l.characterId)?.name || '').toLowerCase().includes(q))
    .sort((a, b) => lineStart(a) - lineStart(b))
  let selRow = null
  for (const l of sorted) {
    const row = document.createElement('div')
    row.className = 'log-row' + (selectedIds.has(l.id) ? ' selected' : '')
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = getChar(l.characterId)?.color || '#888'
    const tc = document.createElement('span')
    tc.className = 'ltc'
    tc.textContent = formatTcShort(lineStart(l))
    const tx = document.createElement('span')
    tx.className = 'ltx'
    tx.textContent = l.words.map((w) => w.text).join(' ')
    row.append(dot, tc, tx)
    row.addEventListener('click', () => {
      selectedIds = new Set([l.id])
      refreshInspector()
      video.pause()
      scrubTo(lineStart(l))
    })
    log.appendChild(row)
    if (selectedIds.has(l.id) && !selRow) selRow = row
  }
  const selKey = [...selectedIds].sort().join(',')
  if (selKey && selKey !== lastLogSel && selRow) selRow.scrollIntoView({ block: 'nearest' })
  lastLogSel = selKey
}

// ============================================================ boucles (scènes)
// Une boucle = une scène : bornes ouverture/fermeture sur la timeline, gérées dans
// le panneau « Boucles » (création/bornage au point de lecture, navigation, type
// OUT). Persistées dans le projet (project.loops). Restent internes au .rythmo —
// non sérialisées en DETX (interopérabilité Cappella/Joker à trancher, cf. ROADMAP).
const loopDur = (lp) => Math.max(0, lp.end - lp.start)
const sortedLoops = () => [...project.loops].sort((a, b) => a.start - b.start)

// une boucle est « hors normes » : normale trop longue, ou OUT trop courte
function loopWarn(lp) {
  if (lp.type === 'out') return loopDur(lp) < LOOP_OUT_MIN_SEC
  return loopDur(lp) > LOOP_WARN_SEC
}

function addLoopAtPlayhead() {
  pushUndo()
  const start = Math.max(0, effectiveTime())
  const end = Math.min(start + LOOP_DEFAULT_SEC, videoDur())
  const lp = { id: uid(), start, end: end > start ? end : start + LOOP_DEFAULT_SEC, name: t('loopName', project.loops.length + 1), type: 'normal' }
  project.loops.push(lp)
  renderLoopsPanel()
  markDirty()
  return lp
}

// navigation : saute au début de la boucle précédente / suivante (dir -1 / +1)
function gotoLoop(dir) {
  const loops = sortedLoops()
  if (!loops.length) return
  const now = effectiveTime()
  let target = null
  if (dir > 0) target = loops.find((lp) => lp.start > now + 0.05)
  else target = [...loops].reverse().find((lp) => lp.start < now - 0.05)
  if (!target) target = dir > 0 ? loops[loops.length - 1] : loops[0]
  video.pause()
  scrubTo(target.start)
}

// panneau « Boucles » : liste chronologique, édition au point de lecture
function renderLoopsPanel() {
  const list = $('loopsList')
  if (!list) return
  list.innerHTML = ''
  const loops = sortedLoops()
  $('loopsEmpty').classList.toggle('hidden', loops.length > 0)
  for (const lp of loops) {
    const row = document.createElement('div')
    row.className = 'loop-row' + (lp.type === 'out' ? ' out' : '')

    const tc = document.createElement('span')
    tc.className = 'ltc'
    tc.textContent = formatTcShort(lp.start)

    const nm = document.createElement('span')
    nm.className = 'lp-name'
    nm.textContent = lp.name

    const dur = document.createElement('span')
    dur.className = 'lp-dur' + (loopWarn(lp) ? ' warn' : '')
    dur.textContent = formatTcShort(loopDur(lp))
    dur.title = loopWarn(lp) ? (lp.type === 'out' ? t('loopOutTooShort', LOOP_OUT_MIN_SEC) : t('loopTooLong', LOOP_WARN_SEC)) : ''

    // boutons : début/fin au point de lecture · type OUT · renommer · supprimer
    const mkBtn = (txt, title, fn, cls) => {
      const b = document.createElement('button')
      b.className = 'lp-btn' + (cls ? ' ' + cls : '')
      b.textContent = txt
      b.title = title
      b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
      return b
    }
    const setStart = mkBtn('⇤', t('loopSetStart'), () => {
      pushUndo(); lp.start = Math.min(Math.max(0, effectiveTime()), lp.end - 0.1); renderLoopsPanel(); markDirty()
    })
    const setEnd = mkBtn('⇥', t('loopSetEnd'), () => {
      pushUndo(); lp.end = Math.max(effectiveTime(), lp.start + 0.1); renderLoopsPanel(); markDirty()
    })
    const out = mkBtn('OUT', t('loopOutTitle'), () => {
      pushUndo(); lp.type = lp.type === 'out' ? 'normal' : 'out'; renderLoopsPanel(); markDirty()
    }, 'lp-out' + (lp.type === 'out' ? ' active' : ''))
    const del = mkBtn('✕', t('loopDelete'), () => {
      pushUndo(); project.loops = project.loops.filter((k) => k.id !== lp.id); renderLoopsPanel(); markDirty()
    }, 'lp-x')

    // renommage en place (double-clic sur le nom)
    nm.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      const inp = document.createElement('input')
      inp.type = 'text'; inp.className = 'nm-input'; inp.value = lp.name; inp.spellcheck = false
      nm.replaceWith(inp); inp.focus(); inp.select()
      let cancelled = false
      const done = () => {
        const nv = inp.value.trim()
        if (!cancelled && nv && nv !== lp.name) { pushUndo(); lp.name = nv; markDirty() }
        renderLoopsPanel()
      }
      inp.addEventListener('blur', done)
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') inp.blur()
        if (ev.key === 'Escape') { cancelled = true; inp.blur() }
        ev.stopPropagation()
      })
    })

    row.append(tc, nm, dur, setStart, setEnd, out, del)
    row.addEventListener('click', () => { video.pause(); scrubTo(lp.start) })
    list.appendChild(row)
  }
}

// dessin des boucles sur la bande (overlay éditeur) : bornes verticales + onglet
// nom sous la règle + liseré le long du haut des pistes. Visualisation seule.
function drawLoops() {
  if (!project.loops.length) return
  const now = effectiveTime()
  const pal = bandPal()
  ctx.save()
  ctx.font = '11px "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'
  for (const lp of sortedLoops()) {
    const x0 = xAtTime(lp.start, now)
    const x1 = xAtTime(lp.end, now)
    if (x1 < -40 || x0 > cw + 40) continue
    const warn = loopWarn(lp)
    const col = warn ? pal.markOut : lp.type === 'out' ? pal.tickText : pal.handleAccent

    // liseré le long du haut des pistes + bornes verticales pleine hauteur
    ctx.strokeStyle = col
    ctx.globalAlpha = 0.9
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(Math.max(0, x0), RULER_H + 1); ctx.lineTo(Math.min(cw, x1), RULER_H + 1); ctx.stroke()
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.35
    for (const bx of [x0, x1]) {
      ctx.beginPath(); ctx.moveTo(bx + 0.5, RULER_H); ctx.lineTo(bx + 0.5, ch); ctx.stroke()
    }

    // onglet du nom, juste sous la règle au début de la boucle
    ctx.globalAlpha = 1
    const label = (lp.type === 'out' ? 'OUT · ' : '') + lp.name
    const tw = ctx.measureText(label).width
    const tabX = clamp(x0 + 2, 0, Math.max(0, cw - tw - 12))
    const tabW = Math.min(tw + 10, cw)
    ctx.fillStyle = col
    ctx.beginPath(); ctx.roundRect(tabX, RULER_H + 2, tabW, 15, 3); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, tabX + 5, RULER_H + 10)
  }
  ctx.restore()
}

// ============================================================ onglets + pistes audio/vidéo
// Onglet « Rythmo » = éditeur de bande (inchangé). Onglet « Pistes » = vue en lanes
// de la piste vidéo (référence) + des pistes audio (embarquées du conteneur, énumérées
// via ffmpeg, et fichiers audio importés). Chaque piste audio se glisse horizontalement
// pour fixer son offset (appliqué à l'export ; aperçu audio à venir avec la lecture
// découplée). Modèle : project.audioTracks = [{id, type:'embedded'|'file', index?, path?,
// offset, exported, isDefault, label, lang, codec, channels}].
let activeTab = 'rythmo'
const baseName = (p) => String(p || '').replace(/^.*[\\/]/, '')
const fmtOffset = (s) => `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(2)} s`

function setTab(name) {
  activeTab = name === 'tracks' ? 'tracks' : 'rythmo'
  const onTracks = activeTab === 'tracks'
  $('tabRythmo').classList.toggle('active', !onTracks)
  $('tabTracks').classList.toggle('active', onTracks)
  $('band').classList.toggle('hidden', onTracks)
  $('inspector').classList.toggle('hidden', onTracks)
  $('tracksView').classList.toggle('hidden', !onTracks)
  if (onTracks) renderTracks()
}
$('tabRythmo').addEventListener('click', () => setTab('rythmo'))
$('tabTracks').addEventListener('click', () => setTab('tracks'))

function embeddedTrackLabel(p) {
  return t('trackAudioName', p.index + 1) + (p.lang ? ` (${p.lang})` : '')
}

// (re)synchronise les pistes audio embarquées avec le sondage ffmpeg, en conservant
// les réglages (offset, export, défaut) déjà présents pour le même index, et les
// pistes externes importées. Appelée au chargement d'une vidéo.
async function probeAndSyncAudio() {
  if (!project.videoPath) return
  const probed = (await window.api.probeAudioTracks(project.videoPath)) || []
  const externals = project.audioTracks.filter((tr) => tr.type === 'file')
  const prev = new Map(project.audioTracks.filter((tr) => tr.type === 'embedded').map((tr) => [tr.index, tr]))
  const embedded = probed.map((p) => {
    const old = prev.get(p.index)
    return {
      id: old?.id || uid(),
      type: 'embedded',
      index: p.index,
      lang: p.lang, codec: p.codec, channels: p.channels,
      label: old?.label || embeddedTrackLabel(p),
      offset: old?.offset || 0,
      exported: old ? old.exported !== false : true,
      isDefault: old?.isDefault || false,
    }
  })
  project.audioTracks = [...embedded, ...externals]
  if (embedded.length && !project.audioTracks.some((tr) => tr.isDefault)) {
    embedded[0].isDefault = true
    embedded[0].exported = true
  }
  if (activeTab === 'tracks') renderTracks()
}

// échelle d'une lane : toute la largeur représente 0..durée de la vidéo
const laneDur = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : 0)

function renderTracks() {
  const wrap = $('tracksLanes')
  wrap.innerHTML = ''
  $('tracksHint').textContent = project.videoPath
    ? (laneDur() ? '' : t('tracksLoading'))
    : t('tracksNoVideo')
  if (!project.videoPath) return

  // ligne vidéo (référence, non déplaçable)
  wrap.appendChild(trackRow({ id: '__video__', kind: 'video', label: t('trackVideoName'), offset: 0 }))
  if (!project.audioTracks.length) {
    const e = document.createElement('div')
    e.className = 'trk-empty'
    e.textContent = t('tracksNoAudio')
    wrap.appendChild(e)
  }
  for (const tr of project.audioTracks) wrap.appendChild(trackRow(tr))
  layoutClips()
}

function trackRow(tr) {
  const row = document.createElement('div')
  row.className = 'trk-row' + (tr.kind === 'video' ? ' video' : '')
  row.dataset.id = tr.id

  const ctl = document.createElement('div')
  ctl.className = 'trk-ctl'
  const label = document.createElement('span')
  label.className = 'trk-label'
  const meta = tr.type === 'embedded' ? `${tr.codec || ''}${tr.channels ? ` · ${tr.channels === 1 ? 'mono' : tr.channels === 2 ? 'stéréo' : tr.channels + 'ch'}` : ''}` : tr.type === 'file' ? t('trackExternal') : ''
  label.textContent = tr.label || baseName(tr.path) || ''
  label.title = meta ? `${label.textContent} — ${meta}` : label.textContent
  ctl.appendChild(label)

  if (tr.kind !== 'video') {
    // export (case) + défaut (radio) + offset + suppression (externe)
    const exp = document.createElement('label')
    const expCb = document.createElement('input')
    expCb.type = 'checkbox'; expCb.checked = tr.exported !== false
    expCb.addEventListener('change', () => { pushUndoTracks(); tr.exported = expCb.checked; markDirty() })
    exp.append(expCb, document.createTextNode(t('trackExport')))
    exp.title = t('trackExportTitle')

    const def = document.createElement('label')
    const defRb = document.createElement('input')
    defRb.type = 'radio'; defRb.name = 'trk-default'; defRb.checked = !!tr.isDefault
    defRb.addEventListener('change', () => {
      pushUndoTracks()
      for (const o of project.audioTracks) o.isDefault = false
      tr.isDefault = true
      if (tr.exported === false) { tr.exported = true; renderTracks() }
      markDirty()
    })
    def.append(defRb, document.createTextNode(t('trackDefault')))
    def.title = t('trackDefaultTitle')

    const off = document.createElement('span')
    off.className = 'trk-off'
    off.textContent = fmtOffset(tr.offset || 0)

    ctl.append(exp, def, off)
    if (tr.type === 'file') {
      const del = document.createElement('button')
      del.className = 'trk-del'; del.textContent = '✕'; del.title = t('trackDelete')
      del.addEventListener('click', () => {
        pushUndoTracks()
        project.audioTracks = project.audioTracks.filter((k) => k.id !== tr.id)
        renderTracks(); markDirty()
      })
      ctl.appendChild(del)
    }
  }

  const lane = document.createElement('div')
  lane.className = 'trk-lane'
  lane.dataset.id = tr.id
  const clip = document.createElement('div')
  clip.className = 'trk-clip'
  const clabel = document.createElement('span')
  clabel.className = 'trk-clip-label'
  clabel.textContent = tr.kind === 'video' ? '🎞' : '🔊'
  clip.appendChild(clabel)
  lane.appendChild(clip)
  const ph = document.createElement('div')
  ph.className = 'trk-ph'
  lane.appendChild(ph)
  if (tr.kind !== 'video') attachClipDrag(clip, lane, tr)
  row.append(ctl, lane)
  return row
}

// place chaque clip selon l'offset de sa piste et la largeur courante de sa lane
function layoutClips() {
  const dur = laneDur()
  for (const lane of $('tracksLanes').querySelectorAll('.trk-lane')) {
    const w = lane.clientWidth
    const clip = lane.querySelector('.trk-clip')
    const id = lane.dataset.id
    const tr = id === '__video__' ? { offset: 0 } : project.audioTracks.find((k) => k.id === id)
    const off = tr ? (tr.offset || 0) : 0
    const pps = dur > 0 ? w / dur : 0
    clip.style.width = `${w}px`
    clip.style.left = `${off * pps}px`
  }
}

// glisser un clip = régler l'offset de la piste (aimanté à 0 près de l'origine)
function attachClipDrag(clip, lane, tr) {
  clip.addEventListener('pointerdown', (e) => {
    const dur = laneDur()
    if (dur <= 0) return
    const pps = lane.clientWidth / dur
    const startX = e.clientX
    const startOff = tr.offset || 0
    clip.setPointerCapture(e.pointerId)
    let pushed = false
    const move = (ev) => {
      if (!pushed) { pushUndoTracks(); pushed = true }
      let off = startOff + (ev.clientX - startX) / pps
      if (Math.abs(off) < 6 / pps) off = 0 // aimant sur l'origine
      off = clamp(off, -dur, dur)
      tr.offset = off
      clip.style.left = `${off * pps}px`
      const offEl = lane.parentElement.querySelector('.trk-off')
      if (offEl) offEl.textContent = fmtOffset(off)
      markDirty()
    }
    const up = () => {
      clip.removeEventListener('pointermove', move)
      clip.removeEventListener('pointerup', up)
    }
    clip.addEventListener('pointermove', move)
    clip.addEventListener('pointerup', up)
  })
}

// l'offset/export/défaut des pistes entre dans l'annuler/rétablir (instantané dédié)
function pushUndoTracks() { pushUndo() }

function updateTracksPlayhead() {
  if (activeTab !== 'tracks') return
  const dur = laneDur()
  const now = effectiveTime()
  for (const lane of $('tracksLanes').querySelectorAll('.trk-lane')) {
    const ph = lane.querySelector('.trk-ph')
    const pps = dur > 0 ? lane.clientWidth / dur : 0
    ph.style.left = `${now * pps}px`
  }
}

// ---------- import d'un fichier audio externe ----------
function addExternalAudio(p) {
  if (!project.videoPath) { toast(t('loadVideoFirst')); return }
  if (!p) return
  pushUndoTracks()
  project.audioTracks.push({ id: uid(), type: 'file', path: p, label: baseName(p), offset: 0, exported: true, isDefault: false, channels: 2 })
  if (activeTab !== 'tracks') setTab('tracks')
  else renderTracks()
  markDirty()
  toast(t('audioImported', baseName(p)))
}
$('btnImportAudio').addEventListener('click', async () => {
  const p = await window.api.openAudio()
  if (p) addExternalAudio(p)
})

// ---------- décalage global de la bande (toutes les répliques) ----------
$('btnShiftApply').addEventListener('click', () => {
  const frames = Number($('shiftAmount').value) || 0
  if (!frames || !project.lines.length) return
  let dt = frames / project.fps
  const minStart = Math.min(...project.lines.map(lineStart))
  if (minStart + dt < 0) dt = -minStart // ne pas passer sous 0
  if (!dt) return
  pushUndo()
  for (const l of project.lines) for (const w of l.words) { w.start += dt; w.end += dt }
  $('shiftAmount').value = '0'
  renderLinesLog()
  refreshInspector()
  markDirty()
  toast(t('shiftDone', frames))
})

new ResizeObserver(() => { if (activeTab === 'tracks') layoutClips() }).observe($('tracksLanes'))

// ============================================================ video info + fps auto-detect
let videoInfo = null
let showVideoInfo = false
let detectingFps = false

function fmtSize(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} ${t('gb')}` : `${(bytes / 1e6).toFixed(1)} ${t('mb')}`
}

function updateVideoInfoPanel() {
  const el = $('videoInfo')
  const visible = showVideoInfo && !!project.videoPath
  el.classList.toggle('hidden', !visible)
  if (!visible) return
  const i = videoInfo || {}
  el.innerHTML = ''
  const rows = [
    [t('infoFile'), i.name || '—'],
    [t('infoContainer'), i.container || '—'],
    [t('infoRes'), i.width ? `${i.width} × ${i.height}` : '—'],
    [t('infoFps'), i.fpsExact ? String(i.fpsExact) : t('detecting')],
    [t('infoDuration'), i.duration ? formatTc(i.duration, project.fps) : '—'],
    [t('infoSize'), i.size ? fmtSize(i.size) : '—'],
    [t('infoAudio'), i.channels ? t('channels', i.channels) : '—'],
  ]
  for (const [k, v] of rows) {
    const div = document.createElement('div')
    const key = document.createElement('span')
    key.textContent = k
    div.appendChild(key)
    div.appendChild(document.createTextNode(v))
    el.appendChild(div)
  }
}

// mesure la cadence réelle via les timestamps des frames décodées
// Cadence réelle lue par ffmpeg côté process principal — aucune lecture de la
// vidéo : la bande et l'aperçu restent immobiles au chargement.
async function detectFps() {
  if (detectingFps || !project.videoPath) return
  detectingFps = true
  try {
    const fps = await window.api.probeFps(project.videoPath)
    if (fps && isFinite(fps)) {
      videoInfo = Object.assign(videoInfo || {}, { fpsExact: Math.round(fps * 100) / 100 })
      project.fps = clamp(Math.round(fps), 10, 120)
    }
  } catch {}
  detectingFps = false
  updateVideoInfoPanel()
}

video.addEventListener('loadedmetadata', () => {
  const p = project.videoPath || ''
  videoInfo = Object.assign({}, videoInfo, {
    name: p.replace(/^.*[\\/]/, ''),
    container: (p.match(/\.(\w+)$/)?.[1] || '').toUpperCase(),
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
  })
  window.api.statFile(p).then((s) => {
    if (s) {
      videoInfo = Object.assign(videoInfo || {}, { size: s.size })
      updateVideoInfoPanel()
    }
  })
  detectFps()
  probeAndSyncAudio()
  updateVideoInfoPanel()
  if (activeTab === 'tracks') renderTracks() // durée connue → échelle des lanes
})

// la vidéo est prête à s'afficher (ou en échec) → on lève l'overlay de chargement
video.addEventListener('loadeddata', () => showLoading(false))
video.addEventListener('error', () => showLoading(false))

// ============================================================ waveform
let wave = null // { peaks: Float32Array, perSec, duration }
let showWave = true
let waveToken = 0
let scrubCtx = null
let scrubBuf = null // audio mono décodé, pour entendre le son pendant le scrub

async function buildWaveform() {
  wave = null
  scrubBuf = null
  const token = ++waveToken
  if (!project.videoPath) return
  try {
    const buf = await window.api.readFile(project.videoPath)
    if (!buf || token !== waveToken) return
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const ac = new AudioContext({ sampleRate: 16000 })
    const audio = await ac.decodeAudioData(ab)
    ac.close()
    if (token !== waveToken) return
    const PER_SEC = 100
    const n = Math.max(1, Math.ceil(audio.duration * PER_SEC))
    const peaks = new Float32Array(n)
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c)
      const spb = audio.sampleRate / PER_SEC
      for (let i = 0; i < d.length; i++) {
        const b = Math.min(n - 1, (i / spb) | 0)
        const v = Math.abs(d[i])
        if (v > peaks[b]) peaks[b] = v
      }
    }
    let max = 0
    for (let i = 0; i < n; i++) if (peaks[i] > max) max = peaks[i]
    if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max
    wave = { peaks, perSec: PER_SEC, duration: audio.duration }
    // mixage mono conservé pour le scrub sonore (rééchantillonné à la lecture)
    const mono = new Float32Array(audio.length)
    for (let ch2 = 0; ch2 < audio.numberOfChannels; ch2++) {
      const d = audio.getChannelData(ch2)
      for (let i = 0; i < d.length; i++) mono[i] += d[i]
    }
    if (audio.numberOfChannels > 1) {
      const k = 1 / audio.numberOfChannels
      for (let i = 0; i < mono.length; i++) mono[i] *= k
    }
    scrubCtx ||= new AudioContext()
    scrubBuf = scrubCtx.createBuffer(1, audio.length, audio.sampleRate)
    scrubBuf.copyToChannel(mono, 0)
    videoInfo = Object.assign(videoInfo || {}, { channels: audio.numberOfChannels })
    updateVideoInfoPanel()
  } catch {
    if (token === waveToken) toast(t('waveFail'))
  }
}

// ============================================================ canvas rendering
let cw = 0, ch = 0 // CSS pixels

function resizeCanvas() {
  const r = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  cw = r.width
  ch = r.height
  canvas.width = Math.round(cw * dpr)
  canvas.height = Math.round(ch * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  recomputePps() // la largeur a pu changer → garder les secondes visibles constantes
}
new ResizeObserver(resizeCanvas).observe(canvas)

const readX = () => cw * READ_RATIO
const xAtTime = (tt, now) => readX() + (tt - now) * pxPerSec
const timeAtX = (x, now) => now + (x - readX()) / pxPerSec
const trackH = () => (ch - RULER_H) / laneCount()
const trackY = (tr) => RULER_H + tr * trackH()

// flèche d'entrée/sortie de réplique : triangle vers le haut = bouche ouverte,
// vers le bas = bouche fermée. side 'in' (vert, à gauche de x) / 'out' (rouge, à
// droite de x). state ∈ 'open' | 'closed' | undefined (rien).
function drawMouthMark(c, x, y, th, state, side, pal) {
  if (state !== 'open' && state !== 'closed') return
  const s = Math.max(3, th * 0.10) // petit triangle (demi-base / demi-hauteur)
  const cx = x                     // centré sur la frontière → à cheval sur la réplique
  const cy = y + th - s            // en bas de la piste, à cheval sur le bord inférieur
  const up = state === 'open'
  c.beginPath()
  if (up) {
    c.moveTo(cx, cy - s)
    c.lineTo(cx + s, cy + s)
    c.lineTo(cx - s, cy + s)
  } else {
    c.moveTo(cx, cy + s)
    c.lineTo(cx + s, cy - s)
    c.lineTo(cx - s, cy - s)
  }
  c.closePath()
  c.fillStyle = side === 'in' ? pal.markIn : pal.markOut
  c.fill()
}

// Rendu de la bande dans un contexte arbitraire (éditeur ou export).
// opts: { ruler, wave, handles }
function renderBand(c, now, W, H, pps, opts) {
  const pal = opts.theme || BAND_THEMES.dark
  const rh = opts.ruler ? RULER_H : 0
  const N = laneCount()
  const th = (H - rh) / N
  const rx = W * READ_RATIO
  const xAt = (tt) => rx + (tt - now) * pps
  const tAt = (x) => now + (x - rx) / pps

  c.fillStyle = pal.bg
  c.fillRect(0, 0, W, H)

  // lanes
  for (let tr = 0; tr < N; tr++) {
    if (tr % 2 === 0) {
      c.fillStyle = pal.lane
      c.fillRect(0, rh + tr * th, W, th)
    }
  }
  c.strokeStyle = pal.grid
  c.beginPath()
  for (let tr = 0; tr <= N; tr++) {
    c.moveTo(0, rh + tr * th + 0.5)
    c.lineTo(W, rh + tr * th + 0.5)
  }
  c.stroke()

  // waveform (semi-transparente, derrière le texte)
  if (opts.wave && wave) {
    const hgt = H - rh
    const midY = rh + hgt / 2
    const amp = hgt / 2 - 3
    const dtPx = 1 / pps
    const w = Math.ceil(W)
    c.beginPath()
    c.moveTo(0, midY)
    const tops = new Float32Array(w)
    for (let x = 0; x < w; x++) {
      const t = tAt(x)
      let v = 0
      if (t >= 0 && t < wave.duration) {
        const b0 = (t * wave.perSec) | 0
        const b1 = Math.max(b0, ((t + dtPx) * wave.perSec) | 0)
        for (let b = b0; b <= b1 && b < wave.peaks.length; b++) {
          if (wave.peaks[b] > v) v = wave.peaks[b]
        }
      }
      tops[x] = v * amp
      c.lineTo(x, midY - tops[x])
    }
    for (let x = w - 1; x >= 0; x--) c.lineTo(x, midY + tops[x])
    c.closePath()
    c.fillStyle = pal.wave
    c.fill()
  }

  // ruler
  if (opts.ruler) {
    c.fillStyle = pal.rulerBg
    c.fillRect(0, 0, W, rh)
    const step = pps < 70 ? 2 : 1
    const t0 = Math.max(0, Math.floor(tAt(0)))
    const t1 = Math.ceil(tAt(W))
    c.font = '12px Consolas, monospace'
    c.textAlign = 'left'
    c.textBaseline = 'middle'
    for (let s = t0 - (t0 % step); s <= t1; s += step) {
      if (s < 0) continue
      const x = xAt(s)
      c.strokeStyle = pal.tick
      c.beginPath()
      c.moveTo(x + 0.5, rh - 8)
      c.lineTo(x + 0.5, rh)
      c.stroke()
      c.fillStyle = pal.tickText
      const mm = String(Math.floor(s / 60)).padStart(2, '0')
      const ss = String(s % 60).padStart(2, '0')
      c.fillText(`${mm}:${ss}`, x + 3, rh / 2)
    }
  }

  // répliques
  for (const line of project.lines) {
    if (opts.tracks && !opts.tracks.has(line.track)) continue // export d'une sélection de pistes
    const s = lineStart(line)
    const e = lineEnd(line)
    const x0 = xAt(s)
    const x1 = xAt(e)
    if (x1 < -50 || x0 > W + 50) continue

    const char = getChar(line.characterId)
    const color = char ? char.color : '#888888'
    const y = rh + line.track * th
    const selected = opts.handles && selectedIds.has(line.id)

    c.fillStyle = color + '22'
    c.beginPath()
    c.roundRect(x0, y + 3, Math.max(4, x1 - x0), th - 6, 5)
    c.fill()
    if (selected) {
      c.strokeStyle = pal.selStroke
      c.lineWidth = 1.5
      c.stroke()
      c.lineWidth = 1
    }

    // ligne de base reliant les mots
    const baseY = y + th * 0.88
    c.strokeStyle = color + '55'
    c.beginPath()
    c.moveTo(x0 + 2, baseY)
    c.lineTo(x1 - 2, baseY)
    c.stroke()

    // nom du personnage — compact, tout en haut de la piste
    const nameFont = Math.max(8, Math.round(th * 0.17))
    c.font = `bold ${nameFont}px "Segoe UI", sans-serif`
    c.fillStyle = color
    c.textAlign = 'left'
    c.textBaseline = 'top'
    c.fillText(char ? char.name : '?', Math.max(2, x0 + 4), y + 2)

    // mots — élongation : chaque mot est étiré sur sa durée réelle
    const fontPx = Math.round(th * 0.52)
    c.font = `bold ${fontPx}px "Segoe UI", sans-serif`
    c.textBaseline = 'alphabetic'
    for (const w of line.words) {
      const wx = xAt(w.start)
      const ww = (w.end - w.start) * pps
      if (wx + ww < 0 || wx > W) continue
      if (w.text !== '_') {
        // "_" = mot vide (silence) : occupe sa durée mais n'affiche rien
        const natural = c.measureText(w.text).width
        // marge autour du mot : le texte ne colle pas aux séparateurs,
        // proportionnelle à la hauteur de piste (bornée pour les mots étroits)
        const pad = Math.max(3, Math.min(th * 0.14, ww * 0.18))
        const scale = Math.max(0.2, (ww - pad * 2) / Math.max(1, natural))
        c.save()
        c.translate(wx + pad, y + th * 0.82)
        c.scale(scale, 1)
        c.fillStyle = color
        c.fillText(w.text, 0, 0)
        c.restore()
      }
      c.strokeStyle = color + '66'
      c.beginPath()
      c.moveTo(wx + 0.5, y + th * 0.36)
      c.lineTo(wx + 0.5, y + th - 4)
      c.stroke()
    }

    // voix off (bouche non visible à l'écran) : texte souligné sur toute la réplique
    if (line.voiceOff) {
      c.strokeStyle = color
      c.lineWidth = Math.max(1, Math.round(th * 0.025))
      c.beginPath()
      c.moveTo(x0 + 3, y + th * 0.85)
      c.lineTo(x1 - 3, y + th * 0.85)
      c.stroke()
      c.lineWidth = 1
    }

    // flèches d'entrée / sortie : bouche ouverte (▲) ou fermée (▼) en début / fin
    // de réplique. Contenu de la bande → dessiné aussi à l'export. Mappe sur DETX
    // <lipsync> in_open/in_close (au début) et out_open/out_close (à la fin).
    drawMouthMark(c, x0, y, th, line.entry, 'in', pal)
    drawMouthMark(c, x1, y, th, line.exit, 'out', pal)

    if (selected && selectedIds.size === 1) {
      // poignées de calage : ligne guide fine sur la frontière + bouton de prise
      // arrondi avec rainures ; extrémités plus grandes (Ctrl = étirement global)
      const knobW = Math.max(6, Math.round(th * 0.13))
      const knobH = Math.max(14, Math.round(th * 0.32))
      for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i]
        const edges = []
        // frontière partagée avec le mot précédent : une seule poignée (celle du end)
        if (i === 0 || Math.abs(line.words[i - 1].end - w.start) > 0.02) {
          edges.push({ t: w.start, type: 'start', wi: i })
        }
        edges.push({ t: w.end, type: 'end', wi: i })
        for (const ed of edges) {
          const hx = Math.round(xAt(ed.t)) + 0.5
          if (hx < -20 || hx > W + 20) continue
          const isExtreme = (ed.type === 'start' && ed.wi === 0) || (ed.type === 'end' && ed.wi === line.words.length - 1)
          const hov = hoverEdge && hoverEdge.lineId === line.id &&
            ((hoverEdge.wi === ed.wi && hoverEdge.type === ed.type) ||
              (hoverEdge.type === 'start' && ed.type === 'end' && hoverEdge.wi === ed.wi + 1))
          const stretch = hov && isExtreme && !hoverEdge.ctrl

          // ligne guide sur toute la hauteur de la piste
          c.strokeStyle = hov ? pal.handleAccent : pal.handle + '55'
          c.beginPath()
          c.moveTo(hx, y + 3)
          c.lineTo(hx, y + th - 3)
          c.stroke()

          // bouton de prise
          const kw = hov ? knobW + 2 : knobW
          const kh = isExtreme ? knobH + Math.round(th * 0.12) : knobH
          const ky = y + (th - kh) / 2
          c.beginPath()
          c.roundRect(hx - kw / 2, ky, kw, kh, 3)
          c.fillStyle = hov ? pal.handleAccent : pal.handle
          c.fill()
          // rainures de grip
          c.strokeStyle = pal.bg + '88'
          c.beginPath()
          c.moveTo(hx - 1.5, ky + 4)
          c.lineTo(hx - 1.5, ky + kh - 4)
          c.moveTo(hx + 1.5, ky + 4)
          c.lineTo(hx + 1.5, ky + kh - 4)
          c.stroke()

          // Ctrl sur une extrémité : chevrons « étirement proportionnel »
          if (stretch) {
            c.strokeStyle = pal.handleAccent
            c.lineWidth = 1.5
            const cy = y + th / 2
            for (const s of [-1, 1]) {
              const bx = hx + s * (kw / 2 + 4)
              c.beginPath()
              c.moveTo(bx, cy - 4)
              c.lineTo(bx + s * 4, cy)
              c.lineTo(bx, cy + 4)
              c.stroke()
            }
            c.lineWidth = 1
          }
        }
      }
    }
  }

  // point de lecture
  const barW = Math.max(2, Math.round(H * 0.012))
  c.strokeStyle = pal.playhead
  c.lineWidth = barW
  c.beginPath()
  c.moveTo(rx, 0)
  c.lineTo(rx, H)
  c.stroke()
  c.lineWidth = 1
  c.fillStyle = pal.playhead
  c.beginPath()
  c.moveTo(rx - 3 * barW, 0)
  c.lineTo(rx + 3 * barW, 0)
  c.lineTo(rx, 4 * barW)
  c.closePath()
  c.fill()
}

function draw() {
  renderBand(ctx, effectiveTime(), cw, ch, pxPerSec, { ruler: true, wave: showWave, handles: true, theme: bandPal() })
  drawLoops()
  drawHoverCursor()
  drawDragGuide()
}

// pendant l'ajustement d'une frontière de mot (ou l'étirement Ctrl) : ligne
// guide bleue sur toute la bande + timecode de la frontière dans la règle
function drawDragGuide() {
  if (!drag) return
  let tt = null
  if (drag.kind === 'edge') tt = drag.line.words[drag.wi][drag.type]
  else if (drag.kind === 'scale') tt = drag.fromStart ? lineStart(drag.line) : lineEnd(drag.line)
  if (tt == null) return
  const pal = bandPal()
  const x = Math.round(xAtTime(tt, effectiveTime())) + 0.5
  ctx.strokeStyle = pal.handleAccent
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, ch)
  ctx.stroke()
  ctx.font = '12px Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const txt = formatTc(tt, project.fps)
  const w = ctx.measureText(txt).width
  const left = x + 7 + w > cw ? x - 9 - w : x + 7
  ctx.fillStyle = pal.rulerBg
  ctx.fillRect(left - 3, 1, w + 6, RULER_H - 2)
  ctx.fillStyle = pal.handleAccent
  ctx.fillText(txt, left, RULER_H / 2)
}

// fin curseur rouge sous la souris quand elle survole la règle, avec son timecode
let hover = null
let hoverEdge = null // poignée de mot survolée : { lineId, wi, type, ctrl }
canvas.addEventListener('pointerleave', () => { hover = null; hoverEdge = null })

// Ctrl pressé/relâché pendant le survol d'une poignée : met à jour l'aperçu
// « étirement proportionnel » (chevrons + curseur) sans attendre un mouvement
function refreshHoverEdge(ctrl) {
  if (!hover || drag) return
  const hit = hitTest(hover.x, hover.y)
  hoverEdge = hit.kind === 'edge' ? { lineId: hit.line.id, wi: hit.wi, type: hit.type, ctrl } : null
  if (hoverEdge) {
    const isFirst = hoverEdge.type === 'start' && hoverEdge.wi === 0
    const isLast = hoverEdge.type === 'end' && hoverEdge.wi === hit.line.words.length - 1
    canvas.style.cursor = !ctrl && (isFirst || isLast) ? 'col-resize' : 'ew-resize'
  }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Control') refreshHoverEdge(true) })
document.addEventListener('keyup', (e) => { if (e.key === 'Control') refreshHoverEdge(false) })

function drawHoverCursor() {
  if (!hover || drag || hover.y > RULER_H) return
  const tt = timeAtX(hover.x, effectiveTime())
  if (tt < 0 || tt > videoDur()) return
  const x = Math.round(hover.x) + 0.5
  ctx.strokeStyle = bandPal().playhead
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, ch)
  ctx.stroke()
  ctx.font = '12px Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const txt = formatTc(tt, project.fps)
  const w = ctx.measureText(txt).width
  const left = hover.x + 7 + w > cw ? hover.x - 9 - w : hover.x + 7
  ctx.fillStyle = bandPal().rulerBg
  ctx.fillRect(left - 3, 1, w + 6, RULER_H - 2)
  ctx.fillStyle = bandPal().playhead
  ctx.fillText(txt, left, RULER_H / 2)
}

// ============================================================ scrub fluide
// Un seul seek vidéo en vol à la fois : pendant le décodage on ne retient que la
// dernière cible. La bande se dessine sur scrub.time (instantané), la vidéo rattrape.
const scrub = { time: null, pending: null, busy: false, active: false }

function scrubTo(t) {
  scrub.time = clamp(t, 0, videoDur())
  scrub.pending = scrub.time
  pumpSeek()
}

function pumpSeek() {
  if (scrub.busy || scrub.pending == null) return
  if (video.readyState < 1) {
    scrub.pending = null
    scrub.time = null
    return
  }
  scrub.busy = true
  video.currentTime = scrub.pending
  scrub.pending = null
}

video.addEventListener('seeked', () => {
  scrub.busy = false
  if (scrub.pending != null) pumpSeek()
  else if (!scrub.active) scrub.time = null // resynchronise le rendu sur la vidéo
})

const effectiveTime = () => (scrub.time != null ? scrub.time : video.currentTime || 0)

// scrub sonore : joue un court grain audio à la position courante (effet « défilement de bande »)
let lastGrain = 0
function playScrubGrain(tt) {
  if (!scrubBuf || !scrubCtx) return
  const vol = Number($('volume').value)
  if (!vol || tt < 0 || tt >= scrubBuf.duration) return
  const nowMs = performance.now()
  if (nowMs - lastGrain < 55) return
  lastGrain = nowMs
  if (scrubCtx.state === 'suspended') scrubCtx.resume()
  const dur = 0.09
  const src = scrubCtx.createBufferSource()
  src.buffer = scrubBuf
  const g = scrubCtx.createGain()
  const t0 = scrubCtx.currentTime
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(vol, t0 + 0.015)
  g.gain.setValueAtTime(vol, t0 + dur - 0.02)
  g.gain.linearRampToValueAtTime(0, t0 + dur)
  src.connect(g)
  g.connect(scrubCtx.destination)
  src.onended = () => { src.disconnect(); g.disconnect() }
  src.start(0, tt, dur)
}

// ============================================================ pointer interactions
let drag = null

// ---------- mode aimant : pendant un glisser de répliques, les bords s'aimantent
// aux bords des autres répliques et au point de lecture (seuil 8 px à l'écran)
let magnetOn = false

$('btnMagnet').addEventListener('click', () => {
  magnetOn = !magnetOn
  $('btnMagnet').classList.toggle('active', magnetOn)
})

function magnetAdjust(d, group) {
  const thresh = 8 / pxPerSec
  const dragIds = new Set(group.map((g) => g.line.id))
  const targets = [effectiveTime()]
  for (const l of project.lines) {
    if (dragIds.has(l.id) || !l.words.length) continue
    targets.push(lineStart(l), lineEnd(l))
  }
  let best = null
  for (const g of group) {
    if (!g.words.length) continue
    for (const edge of [g.words[0].start + d, g.words[g.words.length - 1].end + d]) {
      for (const tt of targets) {
        const delta = tt - edge
        if (Math.abs(delta) <= thresh && (best === null || Math.abs(delta) < Math.abs(best))) best = delta
      }
    }
  }
  return best === null ? d : d + best
}

function hitTest(x, y) {
  const now = effectiveTime()
  const th = trackH()

  // 1. handles of the selected line (single selection only)
  const sel = singleSelected()
  if (sel) {
    const y0 = trackY(sel.track)
    if (y >= y0 && y <= y0 + th) {
      for (let i = 0; i < sel.words.length; i++) {
        const w = sel.words[i]
        const edges = [
          { t: w.start, type: 'start', wi: i },
          { t: w.end, type: 'end', wi: i },
        ]
        for (const ed of edges) {
          if (Math.abs(xAtTime(ed.t, now) - x) <= 6) {
            return { kind: 'edge', line: sel, ...ed }
          }
        }
      }
    }
  }

  // 2. line bodies (selected lines tested first for stacked lines)
  const ordered = [...project.lines].sort((a, b) => (selectedIds.has(a.id) ? -1 : selectedIds.has(b.id) ? 1 : 0))
  for (const line of ordered) {
    const y0 = trackY(line.track)
    if (y < y0 || y > y0 + th) continue
    const t = timeAtX(x, now)
    if (t >= lineStart(line) && t <= lineEnd(line)) return { kind: 'line', line }
  }

  return { kind: 'band' }
}

canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  const hit = hitTest(x, y)
  hoverEdge = null // pas de surbrillance de poignée pendant un drag
  canvas.setPointerCapture(e.pointerId)

  if (hit.kind === 'edge') {
    const line = hit.line
    const w = line.words[hit.wi]
    const isFirst = hit.type === 'start' && hit.wi === 0
    const isLast = hit.type === 'end' && hit.wi === line.words.length - 1
    if ((isFirst || isLast) && !(e.ctrlKey || e.metaKey)) {
      // bord extrême (sans modificateur) : étire toute la réplique proportionnellement
      drag = {
        kind: 'scale',
        line,
        fromStart: isFirst,
        snapshot: line.words.map((wd) => ({ ...wd })),
        anchor: isFirst ? lineEnd(line) : lineStart(line),
      }
      canvas.style.cursor = 'col-resize'
    } else {
      // ctrl sur un bord extrême, ou frontière interne : ajuste seulement ce mot
      // shared boundary with neighbour word (contiguous) → move both
      let alsoWi = -1
      let alsoType = null
      if (hit.type === 'end' && line.words[hit.wi + 1] && Math.abs(line.words[hit.wi + 1].start - w.end) < 0.02) {
        alsoWi = hit.wi + 1; alsoType = 'start'
      } else if (hit.type === 'start' && line.words[hit.wi - 1] && Math.abs(line.words[hit.wi - 1].end - w.start) < 0.02) {
        alsoWi = hit.wi - 1; alsoType = 'end'
      }
      drag = { kind: 'edge', line, wi: hit.wi, type: hit.type, alsoWi, alsoType, x0: x }
      canvas.style.cursor = 'ew-resize'
    }
  } else if (hit.kind === 'line') {
    if (e.ctrlKey || e.metaKey) {
      // ctrl+clic : ajoute / retire de la sélection
      if (selectedIds.has(hit.line.id)) selectedIds.delete(hit.line.id)
      else selectedIds.add(hit.line.id)
    } else if (!selectedIds.has(hit.line.id)) {
      selectedIds = new Set([hit.line.id])
    }
    refreshInspector()
    // drag groupé : toutes les répliques sélectionnées bougent ensemble
    const group = project.lines.filter((l) => selectedIds.has(l.id))
    drag = {
      kind: 'line',
      x0: x,
      group: group.map((l) => ({ line: l, words: l.words.map((w) => ({ ...w })) })),
      moved: false,
    }
    canvas.style.cursor = 'grabbing'
  } else {
    selectedIds.clear()
    refreshInspector()
    video.pause()
    scrub.active = true
    drag = { kind: 'scrub', x0: x, t0: effectiveTime(), tClick: timeAtX(x, effectiveTime()), fromRuler: y <= RULER_H, moved: false }
    canvas.style.cursor = 'grabbing'
  }
})

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    // feedback curseur au survol : poignées de mots, corps de réplique, règle, bande
    const r = canvas.getBoundingClientRect()
    hover = { x: e.clientX - r.left, y: e.clientY - r.top }
    const hit = hitTest(hover.x, hover.y)
    hoverEdge = hit.kind === 'edge'
      ? { lineId: hit.line.id, wi: hit.wi, type: hit.type, ctrl: e.ctrlKey || e.metaKey }
      : null
    let cur = hit.kind === 'edge' ? 'ew-resize' : hit.kind === 'line' ? 'move' : 'grab'
    if (hover.y <= RULER_H) cur = 'pointer' // règle : clic = aller à cet endroit
    if (hit.kind === 'edge' && !(e.ctrlKey || e.metaKey)) {
      const isFirst = hit.type === 'start' && hit.wi === 0
      const isLast = hit.type === 'end' && hit.wi === hit.line.words.length - 1
      if (isFirst || isLast) cur = 'col-resize' // bord extrême : étirement de toute la réplique
    }
    canvas.style.cursor = cur
    return
  }
  const r = canvas.getBoundingClientRect()
  const x = e.clientX - r.left
  const dx = x - drag.x0
  const dt = dx / pxPerSec

  if (drag.kind === 'scrub') {
    if (Math.abs(dx) > 3) drag.moved = true
    if (drag.moved) {
      scrubTo(drag.t0 - dt)
      playScrubGrain(scrub.time)
    }
  } else if (drag.kind === 'line') {
    if (Math.abs(dx) > 3) drag.moved = true
    if (drag.moved) {
      if (!drag.pushed) { pushUndo(); drag.pushed = true }
      let d = dt
      if (magnetOn) d = magnetAdjust(d, drag.group)
      const minStart = Math.min(...drag.group.map((g) => g.words[0].start))
      if (minStart + d < 0) d = -minStart
      for (const g of drag.group) {
        g.line.words.forEach((w, i) => {
          w.start = g.words[i].start + d
          w.end = g.words[i].end + d
        })
      }
      markDirty()
      refreshInspector()
    }
  } else if (drag.kind === 'scale') {
    if (!drag.pushed) { pushUndo(); drag.pushed = true }
    const t = timeAtX(x, effectiveTime())
    const { line, snapshot, anchor, fromStart } = drag
    const MIN = 0.1
    if (fromStart) {
      const newStart = clamp(t, 0, anchor - MIN)
      const k = (anchor - newStart) / Math.max(0.001, anchor - snapshot[0].start)
      line.words.forEach((w, i) => {
        w.start = anchor - (anchor - snapshot[i].start) * k
        w.end = anchor - (anchor - snapshot[i].end) * k
      })
    } else {
      const newEnd = Math.max(t, anchor + MIN)
      const k = (newEnd - anchor) / Math.max(0.001, snapshot[snapshot.length - 1].end - anchor)
      line.words.forEach((w, i) => {
        w.start = anchor + (snapshot[i].start - anchor) * k
        w.end = anchor + (snapshot[i].end - anchor) * k
      })
    }
    markDirty()
    refreshInspector()
  } else if (drag.kind === 'edge') {
    if (!drag.pushed) { pushUndo(); drag.pushed = true }
    const now = effectiveTime()
    const line = drag.line
    const w = line.words[drag.wi]
    const t = timeAtX(x, now)
    const MIN = 0.06
    if (drag.type === 'end') {
      const lo = w.start + MIN
      const hi = drag.alsoWi >= 0 ? line.words[drag.alsoWi].end - MIN : (line.words[drag.wi + 1] ? line.words[drag.wi + 1].start : 1e9)
      w.end = clamp(t, lo, hi)
      if (drag.alsoWi >= 0) line.words[drag.alsoWi].start = w.end
    } else {
      const hi = w.end - MIN
      const lo = drag.alsoWi >= 0 ? line.words[drag.alsoWi].start + MIN : (line.words[drag.wi - 1] ? line.words[drag.wi - 1].end : 0)
      w.start = clamp(t, Math.max(0, lo), hi)
      if (drag.alsoWi >= 0) line.words[drag.alsoWi].end = w.start
    }
    markDirty()
    refreshInspector()
  }
})

// clic sur la règle temporelle = aller à cet endroit (immédiat : le double-clic
// ne crée des répliques que sous la règle, donc aucun conflit)
function endDrag() {
  if (drag && drag.kind === 'scrub' && drag.fromRuler && !drag.moved && video.src) {
    scrubTo(drag.tClick)
  }
  drag = null
  scrub.active = false
  if (!scrub.busy && scrub.pending == null) scrub.time = null
  canvas.style.cursor = 'grab'
}
canvas.addEventListener('pointerup', endDrag)
canvas.addEventListener('pointercancel', endDrag)

canvas.addEventListener('dblclick', (e) => {
  const r = canvas.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  const hit = hitTest(x, y)
  if (hit.kind === 'line') {
    selectedIds = new Set([hit.line.id])
    refreshInspector()
    ins.text.focus()
    ins.text.select()
  } else if (y > RULER_H) {
    const tr = clamp(Math.floor((y - RULER_H) / trackH()), 0, laneCount() - 1)
    const t = timeAtX(x, effectiveTime())
    addLineAt(t, tr, '…', 2)
    ins.text.focus()
    ins.text.select()
  }
})

// wheel = horizontal scrub · ctrl+wheel = zoom (en secondes visibles)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (e.ctrlKey) {
    secondsVisible = clamp(secondsVisible * (e.deltaY < 0 ? 1 / 1.12 : 1.12), SEC_MIN, SEC_MAX)
    recomputePps()
    syncZoomSlider()
    return
  }
  video.pause()
  const d = (e.deltaY || e.deltaX) / pxPerSec * 0.8
  scrubTo(effectiveTime() + d)
  playScrubGrain(scrub.time)
}, { passive: false })

// slider de zoom (transport) — échelle logarithmique : gauche = 10 s, droite = 1 s
const zoomSlider = $('zoom')

function syncZoomSlider() {
  zoomSlider.value = String(Math.log(secondsVisible / SEC_MAX) / Math.log(SEC_MIN / SEC_MAX))
}

zoomSlider.addEventListener('input', () => {
  secondsVisible = SEC_MAX * Math.pow(SEC_MIN / SEC_MAX, Number(zoomSlider.value))
  recomputePps()
})
syncZoomSlider()

// ============================================================ transport
const btnPlay = $('tPlay')

function togglePlay() {
  if (!video.src) return
  if (video.paused) video.play()
  else video.pause()
}

btnPlay.addEventListener('click', togglePlay)
$('tStart').addEventListener('click', () => { video.currentTime = 0 })
$('tFrameB').addEventListener('click', () => { video.pause(); video.currentTime = clamp(video.currentTime - 1 / project.fps, 0, videoDur()) })
$('tFrameF').addEventListener('click', () => { video.pause(); video.currentTime = clamp(video.currentTime + 1 / project.fps, 0, videoDur()) })
$('speed').addEventListener('change', (e) => { video.playbackRate = Number(e.target.value) })
$('volume').addEventListener('input', (e) => { video.volume = Number(e.target.value) })

$('btnAddLine').addEventListener('click', () => {
  addLineAt(video.currentTime, null, '…', 2)
  ins.text.focus()
  ins.text.select()
})

// ============================================================ réacs (lexique)
// Le lexique vit dans reacs.js (REACS / REAC_BY_KEY). Le token inséré est localisé
// (FR ou EN selon la langue de l'UI). Une réac est posée comme une réplique courte
// (kind='reac' pour le DETX), sans flèche entrée/sortie par défaut — comme une
// réplique normale, l'utilisateur les ajoute s'il le souhaite. Insertion à la
// palette « Réactions » ou directement par la touche du lexique.
const REAC_DUR = 0.8 // durée par défaut d'une réac insérée
const onomaPop = $('onomaPop')

// token écrit dans le projet/DETX, dans la langue courante
const reacToken = (r) => (lang === 'en' ? r.en : r.fr)

function insertReac(r) {
  pushUndo()
  if (!project.characters.length) addCharacter()
  const start = Math.max(0, effectiveTime())
  const line = {
    id: uid(),
    characterId: selectedCharId || project.characters[0].id,
    track: findFreeTrack(start, start + REAC_DUR),
    kind: 'reac',
    words: splitWords(reacToken(r), start, start + REAC_DUR),
  }
  project.lines.push(line)
  selectedIds = new Set([line.id])
  refreshInspector()
  markDirty()
}

function buildOnomaPop() {
  onomaPop.innerHTML = ''
  for (const r of REACS) {
    const b = document.createElement('button')
    b.className = 'ono-chip'
    b.title = t('reacChipTitle', reacToken(r), r.key)
    const tok = document.createElement('span')
    tok.textContent = reacToken(r)
    const k = document.createElement('span')
    k.className = 'k'
    k.textContent = r.key
    b.append(tok, k)
    b.addEventListener('click', () => {
      insertReac(r)
      onomaPop.classList.add('hidden')
    })
    onomaPop.appendChild(b)
  }
}
buildOnomaPop()

$('btnOnoma').addEventListener('click', (e) => {
  e.stopPropagation()
  if (!onomaPop.classList.contains('hidden')) {
    onomaPop.classList.add('hidden')
    return
  }
  const r = e.currentTarget.getBoundingClientRect()
  onomaPop.style.left = `${r.left}px`
  onomaPop.style.bottom = `${window.innerHeight - r.top + 6}px`
  onomaPop.classList.remove('hidden')
})
document.addEventListener('click', (e) => {
  if (!onomaPop.classList.contains('hidden') && !onomaPop.contains(e.target)) {
    onomaPop.classList.add('hidden')
  }
})


// ============================================================ keyboard
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase()
  const typing = tag === 'input' || tag === 'select' || tag === 'textarea'

  // Ctrl+F : recherche dans les répliques — fonctionne même depuis un champ de saisie
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openLineSearch()
    return
  }

  if (typing) {
    if (e.key === 'Escape') e.target.blur()
    return
  }

  // copier / couper / coller des répliques sélectionnées (calage + bornes conservés)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copyLines(); return }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { e.preventDefault(); copyLines(); deleteSelected(); return }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteLines(); return }

  // touche du lexique = insertion directe d'une réac au point de lecture
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    const reac = REAC_BY_KEY.get(e.key)
    if (reac) {
      e.preventDefault()
      insertReac(reac)
      return
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectedIds = new Set(project.lines.map((l) => l.id))
    refreshInspector()
    return
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    redo()
    return
  }

  switch (e.key) {
    case ' ':
      e.preventDefault()
      togglePlay()
      break
    case 'ArrowLeft':
      e.preventDefault()
      video.pause()
      video.currentTime = clamp(video.currentTime - (e.shiftKey ? 1 : 1 / project.fps), 0, videoDur())
      break
    case 'ArrowRight':
      e.preventDefault()
      video.pause()
      video.currentTime = clamp(video.currentTime + (e.shiftKey ? 1 : 1 / project.fps), 0, videoDur())
      break
    case 'Enter':
      e.preventDefault()
      addLineAt(video.currentTime, null, '…', 2)
      ins.text.focus()
      ins.text.select()
      break
    case 'PageUp':
      e.preventDefault()
      gotoLoop(-1)
      break
    case 'PageDown':
      e.preventDefault()
      gotoLoop(1)
      break
    case 'Delete':
    case 'Backspace':
      deleteSelected()
      break
    case 'Escape':
      if (!$('guideModal').classList.contains('hidden')) {
        $('guideModal').classList.add('hidden')
        break
      }
      if (!onomaPop.classList.contains('hidden')) {
        onomaPop.classList.add('hidden')
        break
      }
      selectedIds.clear()
      refreshInspector()
      break
  }
})

// ============================================================ file ops
// Garde-fou commun avant d'écraser le projet courant (Nouveau projet, ouverture
// d'un projet, glisser-déposer) : propose d'enregistrer les modifications en
// cours. Retourne true si l'on peut continuer, false si l'utilisateur a annulé.
async function confirmDiscardIfDirty() {
  if (!dirty) return true
  const r = await window.api.confirmUnsaved()
  if (r === 'cancel') return false
  if (r === 'save') {
    await saveProject()
    if (dirty) return false // enregistrement annulé dans le dialogue → on ne perd rien
  }
  return true
}

// Fichier → Nouveau projet : comportement standard — propose d'enregistrer
// les modifications en cours, puis repart d'un projet vierge (vidéo comprise)
async function newProjectAction() {
  if (!(await confirmDiscardIfDirty())) return
  video.pause()
  project = newProject()
  projectPath = null
  selectedCharId = null
  selectedIds = new Set()
  undoStack = []
  redoStack = []
  syncUndoMenu()
  waveToken++ // invalide une éventuelle analyse de forme d'onde en cours
  wave = null
  scrubBuf = null
  videoInfo = null
  video.removeAttribute('src')
  video.load()
  $('dropHint').style.display = ''
  updateVideoInfoPanel()
  renderChars()
  applyBandHeight()
  lineFilterTrack = null
  buildLineFilterOptions()
  refreshInspector()
  renderLinesLog()
  renderLoopsPanel()
  if (activeTab === 'tracks') renderTracks()
  setClean()
}

async function setVideo(path, url) {
  project.videoPath = path
  project.audioTracks = [] // nouveau conteneur → pistes re-sondées (probeAndSyncAudio)
  videoInfo = null
  showLoading(true, t('loadingVideo'))
  video.src = url
  $('dropHint').style.display = 'none'
  markDirty()
  buildWaveform()
}

async function openVideoDialog() {
  const r = await window.api.openVideo()
  if (r) setVideo(r.path, r.url)
}

async function saveProject() {
  const json = JSON.stringify(project, null, 2)
  const p = await window.api.saveProject(json, projectPath)
  if (p) {
    projectPath = p
    setClean()
    toast(t('saved'))
  }
}
async function saveProjectAs() {
  const p = await window.api.saveProjectAs(JSON.stringify(project, null, 2), projectPath)
  if (p) {
    projectPath = p
    setClean()
    toast(t('saved'))
  }
}

async function openProjectDialog() {
  if (!(await confirmDiscardIfDirty())) return
  const r = await window.api.openProject()
  if (!r) return
  try {
    loadProjectData(JSON.parse(r.data), r.path)
  } catch (err) {
    toast(t('invalidProject'))
  }
}

async function loadProjectData(data, path) {
  project = Object.assign(newProject(), data)
  project.characters ||= []
  project.lines ||= []
  project.loops ||= []
  // rétrocompat : modèle v2 « sources.audioTracks » accepté, sinon liste vide
  project.audioTracks ||= (data.sources && data.sources.audioTracks) || []
  // nombre de pistes : valeur enregistrée si présente, sinon déduite des données
  // (les anciens projets sans champ `tracks` ne doivent jamais masquer une piste)
  const maxUsed = project.lines.reduce((m, l) => Math.max(m, l.track || 0), -1)
  project.tracks = clamp(Math.max(data.tracks || DEFAULT_TRACKS, maxUsed + 1), 1, MAX_TRACKS)
  projectPath = path || null
  selectedCharId = project.characters[0]?.id || null
  selectedIds = new Set()
  undoStack = []
  redoStack = []
  syncUndoMenu()
  renderChars()
  applyBandHeight()
  lineFilterTrack = null
  buildLineFilterOptions()
  refreshInspector()
  renderLinesLog()
  renderLoopsPanel()
  setClean()
  if (project.videoPath) {
    const url = await window.api.fileUrl(project.videoPath)
    if (url) {
      videoInfo = null
      showLoading(true, t('loadingProject'))
      video.src = url
      $('dropHint').style.display = 'none'
      buildWaveform()
    } else {
      toast(t('videoNotFound', project.videoPath))
    }
  }
}

// ============================================================ SRT import
function parseSrt(text) {
  const cues = []
  const blocks = text.replace(/\r/g, '').split(/\n\n+/)
  const reTime = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const ti = lines.findIndex((l) => reTime.test(l))
    if (ti === -1) continue
    const m = lines[ti].match(reTime)
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000
    const txt = lines.slice(ti + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (txt && end > start) cues.push({ start, end, text: txt })
  }
  return cues
}

function importSrtText(text) {
  const cues = parseSrt(text)
  if (!cues.length) {
    toast(t('srtNone'))
    return
  }
  pushUndo()
  if (!project.characters.length) addCharacter('Import')
  const charId = selectedCharId || project.characters[0].id
  for (const cue of cues) {
    project.lines.push({
      id: uid(),
      characterId: charId,
      track: findFreeTrack(cue.start, cue.end),
      words: splitWords(cue.text, cue.start, cue.end),
    })
  }
  markDirty()
  toast(t('srtImported', cues.length))
}

async function importSrtDialog() {
  const text = await window.api.importSrt()
  if (text) importSrtText(text)
}

// ---------- export / réimport SRT (correction orthographique externe)
function srtTime(tt) {
  const ms = Math.round(Math.max(0, tt) * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

function buildSrtText() {
  const sorted = [...project.lines].filter((l) => l.words.length).sort((a, b) => lineStart(a) - lineStart(b))
  return sorted
    .map((l, i) => `${i + 1}\n${srtTime(lineStart(l))} --> ${srtTime(lineEnd(l))}\n${l.words.map((w) => w.text).join(' ')}\n`)
    .join('\n')
}

async function exportSrtDialog() {
  if (!project.lines.length) {
    toast(t('noLinesToExport'))
    return
  }
  const base = (projectPath || project.videoPath || 'sous-titres').replace(/\.rythmo\.json$/i, '').replace(/\.\w+$/, '')
  const p = await window.api.exportSrt(buildSrtText(), base + '.srt')
  if (p) toast(t('srtExported', p.replace(/^.*[\\/]/, '')))
}

// réinjecte les textes corrigés sans toucher au calage : chaque cue est rapprochée
// de la réplique dont le début est le plus proche (< 0,5 s)
function updateFromSrt(text) {
  const cues = parseSrt(text)
  if (!cues.length) {
    toast(t('srtNone'))
    return
  }
  pushUndo()
  let updated = 0
  for (const cue of cues) {
    let best = null
    let bestD = 0.5
    for (const l of project.lines) {
      const d = Math.abs(lineStart(l) - cue.start)
      if (d < bestD) { best = l; bestD = d }
    }
    if (!best) continue
    const tokens = cue.text.trim().split(/\s+/).filter(Boolean)
    if (!tokens.length) continue
    if (tokens.length === best.words.length) {
      best.words.forEach((w, i) => { w.text = tokens[i] }) // calage mot à mot préservé
    } else {
      best.words = splitWords(cue.text, lineStart(best), lineEnd(best))
    }
    updated++
  }
  markDirty()
  refreshInspector()
  toast(t('srtUpdated', updated))
}

async function updateSrtDialog() {
  const text = await window.api.importSrt()
  if (text) updateFromSrt(text)
}

// ============================================================ DETX import/export
// Format d'échange des bandes rythmo (spec : Joker DetX.md). XML header/roles/body ;
// chaque <line role track> porte le texte en clair, et son début/fin via des <lipsync>
// in_*/out_* (timecode HH:MM:SS:FF). Nos flèches entrée/sortie ↔ in_open/in_close/
// out_open/out_close ; absence de flèche ↔ neutral. Le timing par mot (élongation) n'est
// pas représentable en DETX : à l'import, le texte est re-réparti sur la durée.
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function buildDetx() {
  const lines = [...project.lines].filter((l) => l.words.length).sort((a, b) => lineStart(a) - lineStart(b))
  const tc = (t) => formatTc(t, project.fps)
  const o = []
  o.push('<?xml version="1.0" encoding="UTF-8" standalone="no" ?>')
  o.push('<detx copyright="LibreRythmo">')
  o.push('  <header>')
  o.push('    <cappella version="3.7.0"/>')
  if (project.videoPath) o.push(`    <videofile>${xmlEsc(project.videoPath)}</videofile>`)
  o.push('    <last_position timecode="00:00:00:00" track="0"/>')
  o.push('  </header>')
  o.push('  <roles>')
  for (const c of project.characters) {
    o.push(`    <role id="${xmlEsc(c.id)}" name="${xmlEsc(c.name)}" color="${xmlEsc(c.color || '#000000')}" description=""/>`)
  }
  o.push('  </roles>')
  o.push('  <body>')
  for (const l of lines) {
    const isReac = l.kind === 'reac' || (l.words.length === 1 && /^\(.*\)$/.test(l.words[0].text))
    const startType = l.entry === 'open' ? 'in_open' : l.entry === 'closed' ? 'in_close' : 'neutral'
    const endType = l.exit === 'open' ? 'out_open' : l.exit === 'closed' ? 'out_close' : 'neutral'
    const text = l.words.map((w) => w.text).join(' ')
    // voiceoff : attribut hors spec Cappella (ignoré par les autres outils) mais
    // relu à l'import LibreRythmo → survie de la voix off en aller-retour DETX.
    o.push(`    <line role="${xmlEsc(l.characterId)}" track="${l.track || 0}"${isReac ? ' type="reac"' : ''}${l.voiceOff ? ' voiceoff="true"' : ''}>`)
    o.push(`      <lipsync timecode="${tc(lineStart(l))}" type="${startType}"/>`)
    o.push(`      <text>${xmlEsc(text)}</text>`)
    o.push(`      <lipsync timecode="${tc(lineEnd(l))}" type="${endType}"/>`)
    o.push('    </line>')
  }
  o.push('  </body>')
  o.push('</detx>')
  return o.join('\n')
}

// DETX → objet projet (réutilise loadProjectData pour le reste : vidéo, undo, rendu…)
function parseDetx(xmlText, fps) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('detx').length) {
    throw new Error('invalid detx')
  }
  const characters = []
  const roleIds = new Set()
  for (const r of doc.getElementsByTagName('role')) {
    const id = r.getAttribute('id') || uid()
    characters.push({ id, name: r.getAttribute('name') || id, color: r.getAttribute('color') || '#888888' })
    roleIds.add(id)
  }
  if (!characters.length) characters.push({ id: uid(), name: t('defaultChar', 1), color: PALETTE[0] })
  const fallbackId = characters[0].id

  const lines = []
  let maxTrack = 0
  for (const ln of doc.getElementsByTagName('line')) {
    const syncs = [...ln.getElementsByTagName('lipsync')]
      .map((s) => ({ t: parseTc(s.getAttribute('timecode') || s.getAttribute('tc') || '', fps), type: s.getAttribute('type') || 'neutral' }))
      .filter((s) => s.t != null)
    if (!syncs.length) continue
    const start = Math.min(...syncs.map((s) => s.t))
    const end = Math.max(...syncs.map((s) => s.t))
    if (!(end > start)) continue
    const textEl = ln.getElementsByTagName('text')[0]
    const text = (textEl ? textEl.textContent : '').replace(/\s+/g, ' ').trim()
    const role = ln.getAttribute('role')
    const track = clamp(parseInt(ln.getAttribute('track') || '0', 10) || 0, 0, MAX_TRACKS - 1)
    const inSync = syncs.find((s) => s.type === 'in_open' || s.type === 'in_close')
    const outSync = syncs.find((s) => s.type === 'out_open' || s.type === 'out_close')
    const line = {
      id: uid(),
      characterId: roleIds.has(role) ? role : fallbackId,
      track,
      words: splitWords(text || '…', start, end),
    }
    if (inSync) line.entry = inSync.type === 'in_close' ? 'closed' : 'open'
    if (outSync) line.exit = outSync.type === 'out_close' ? 'closed' : 'open'
    if (ln.getAttribute('type') === 'reac') line.kind = 'reac'
    const vo = ln.getAttribute('voiceoff')
    if (vo === 'true' || vo === '1') line.voiceOff = true
    lines.push(line)
    maxTrack = Math.max(maxTrack, track)
  }
  const vf = doc.getElementsByTagName('videofile')[0]
  return {
    version: 1,
    videoPath: vf && vf.textContent.trim() ? vf.textContent.trim() : null,
    fps,
    tracks: clamp(maxTrack + 1, 1, MAX_TRACKS),
    characters,
    lines,
  }
}

async function importDetxDialog() {
  if (!(await confirmDiscardIfDirty())) return
  const r = await window.api.importDetx()
  if (!r) return
  try {
    const data = parseDetx(r.data, project.fps)
    await loadProjectData(data, null) // projet issu du DETX (à enregistrer en .rythmo si besoin)
    toast(t('detxImported', data.lines.length))
  } catch {
    toast(t('detxInvalid'))
  }
}

// importe seulement les personnages d'un DETX dans le projet courant (gabarit de
// série) — n'écrase ni les répliques ni la vidéo. Doublons (même nom) ignorés.
async function importDetxRolesDialog() {
  const r = await window.api.importDetx()
  if (!r) return
  let chars
  try {
    chars = parseDetx(r.data, project.fps).characters
  } catch {
    toast(t('detxInvalid'))
    return
  }
  const existing = new Set(project.characters.map((c) => c.name.toLowerCase()))
  const usedIds = new Set(project.characters.map((c) => c.id))
  const toAdd = []
  for (const c of chars) {
    if (existing.has(c.name.toLowerCase())) continue
    existing.add(c.name.toLowerCase())
    const id = usedIds.has(c.id) ? uid() : c.id
    usedIds.add(id)
    toAdd.push({ id, name: c.name, color: c.color || PALETTE[(project.characters.length + toAdd.length) % PALETTE.length] })
  }
  if (!toAdd.length) { toast(t('rolesNone')); return }
  pushUndo()
  project.characters.push(...toAdd)
  if (!getChar(selectedCharId)) selectedCharId = project.characters[0].id
  renderChars()
  refreshInspector()
  markDirty()
  toast(t('rolesImported', toAdd.length))
}

async function exportDetxDialog() {
  if (!project.lines.length) {
    toast(t('noLinesToExport'))
    return
  }
  const base = (projectPath || project.videoPath || 'projet').replace(/\.rythmo(\.json)?$/i, '').replace(/\.\w+$/, '')
  const p = await window.api.exportDetx(buildDetx(), base + '.detx')
  if (p) toast(t('detxExported', p.replace(/^.*[\\/]/, '')))
}

// ============================================================ export PDF (script)
// Script de doublage façon conducteur cinéma : chronologique, timecode + personnage
// (capitales, pastille couleur) puis dialogue indenté, police machine à écrire.
function scriptTitle() {
  return (projectPath || project.videoPath || 'Script').replace(/^.*[\\/]/, '').replace(/\.\w+$/, '') || 'Script'
}

function buildScriptHtml() {
  const lines = [...project.lines].filter((l) => l.words.length).sort((a, b) => lineStart(a) - lineStart(b))
  const title = scriptTitle()
  let date = ''
  try { date = new Date().toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }) } catch {}
  const rows = lines.map((l) => {
    const c = getChar(l.characterId)
    const name = (c ? c.name : '?').toUpperCase()
    const color = c ? c.color : '#888888'
    const tc = formatTc(lineStart(l), project.fps)
    const text = l.words.map((w) => w.text).filter((w) => w !== '_').join(' ')
    return `<div class="e"><div class="h"><span class="tc">${xmlEsc(tc)}</span>` +
      `<span class="dot" style="background:${xmlEsc(color)}"></span>` +
      `<span class="nm">${xmlEsc(name)}</span></div><div class="d">${xmlEsc(text)}</div></div>`
  }).join('')
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Courier New', Courier, monospace; font-size: 11pt; color: #111; margin: 0; }
    .title { font-size: 17pt; font-weight: bold; margin: 0 0 3pt; }
    .meta { color: #777; font-size: 9pt; margin-bottom: 14pt; text-transform: uppercase; letter-spacing: .5pt; }
    .rule { border-bottom: 1.5px solid #111; margin-bottom: 16pt; }
    .e { margin-bottom: 13pt; page-break-inside: avoid; }
    .h { display: flex; align-items: baseline; gap: 9pt; }
    .tc { color: #555; font-size: 9.5pt; min-width: 86pt; }
    .dot { width: 8pt; height: 8pt; border-radius: 50%; display: inline-block; transform: translateY(1pt); }
    .nm { font-weight: bold; letter-spacing: 1pt; }
    .d { margin: 3pt 0 0 95pt; white-space: pre-wrap; line-height: 1.45; }
  </style></head><body>
    <div class="title">${xmlEsc(title)}</div>
    <div class="meta">${xmlEsc(t('pdfSubtitle'))}${date ? ' · ' + xmlEsc(date) : ''} · ${lines.length} ${xmlEsc(t('pdfLines'))}</div>
    <div class="rule"></div>
    ${rows}
  </body></html>`
}

async function exportPdfDialog() {
  if (!project.lines.length) {
    toast(t('noLinesToExport'))
    return
  }
  const base = (projectPath || project.videoPath || 'script').replace(/\.rythmo(\.json)?$/i, '').replace(/\.\w+$/, '')
  const r = await window.api.exportPdf(buildScriptHtml(), base + '.pdf')
  if (r && r.error) { toast(t('pdfFailed')); console.error('pdf:', r.error); return }
  if (r) toast(t('pdfExported', r.replace(/^.*[\\/]/, '')))
}

// menu natif → actions
window.api.onMenu((action, arg) => {
  if (action === 'new-project') newProjectAction()
  else if (action === 'open-video') openVideoDialog()
  else if (action === 'open-project') openProjectDialog()
  else if (action === 'save-project') saveProject()
  else if (action === 'save-project-as') saveProjectAs()
  else if (action === 'import-srt') importSrtDialog()
  else if (action === 'export-srt') exportSrtDialog()
  else if (action === 'update-srt') updateSrtDialog()
  else if (action === 'import-detx') importDetxDialog()
  else if (action === 'import-detx-roles') importDetxRolesDialog()
  else if (action === 'export-detx') exportDetxDialog()
  else if (action === 'export-pdf') exportPdfDialog()
  else if (action === 'toggle-wave') { showWave = !!arg; pushSettings() }
  else if (action === 'export-video') openExportModal()
  else if (action === 'set-lang') setLanguage(arg)
  else if (action === 'show-guide') openGuide()
  else if (action === 'undo') undo()
  else if (action === 'redo') redo()
  else if (action === 'open-recent') openRecentProject(arg)
  else if (action === 'toggle-theme') {
    setTheme(arg ? 'light' : 'dark')
    pushSettings()
  }
  else if (action === 'toggle-autosave') {
    autosaveOn = !!arg
    updateTitle()
    if (autosaveOn) scheduleAutosave()
    pushSettings()
  }
  else if (action === 'toggle-video-info') {
    showVideoInfo = !!arg
    updateVideoInfoPanel()
    pushSettings()
  }
})

async function openRecentProject(p) {
  if (!(await confirmDiscardIfDirty())) return
  const r = await window.api.openProjectPath(p)
  if (!r) {
    toast(t('fileNotFound', p))
    return
  }
  try {
    loadProjectData(JSON.parse(r.data), r.path)
  } catch {
    toast(t('invalidProject'))
  }
}

// ============================================================ guide (Aide → Guide)
function buildGuide() {
  $('guideTitle').textContent = t('guideTitle')
  $('guideClose').textContent = t('close')
  const body = $('guideBody')
  body.innerHTML = ''
  for (const sec of t('guideSections')) {
    const div = document.createElement('div')
    div.className = 'g-section'
    const h = document.createElement('h4')
    h.textContent = `${sec.icon}  ${sec.title}`
    div.appendChild(h)
    for (const [keys, desc] of sec.items) {
      const row = document.createElement('div')
      row.className = 'g-item'
      const kspan = document.createElement('span')
      kspan.className = 'keys'
      if (keys) {
        const kbd = document.createElement('kbd')
        kbd.textContent = keys
        kspan.appendChild(kbd)
      }
      const dspan = document.createElement('span')
      dspan.className = 'desc'
      dspan.textContent = desc
      row.append(kspan, dspan)
      div.appendChild(row)
    }
    body.appendChild(div)
  }
}

function openGuide() {
  buildGuide()
  $('guideModal').classList.remove('hidden')
}

$('guideClose').addEventListener('click', () => $('guideModal').classList.add('hidden'))
$('guideModal').addEventListener('click', (e) => {
  if (e.target === $('guideModal')) $('guideModal').classList.add('hidden')
})

// ============================================================ drag & drop
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (!file) return
  const name = file.name.toLowerCase()
  if (name.endsWith('.srt')) {
    importSrtText(await file.text())
  } else if (name.endsWith('.detx')) {
    if (!(await confirmDiscardIfDirty())) return
    try {
      const data = parseDetx(await file.text(), project.fps)
      await loadProjectData(data, null)
      toast(t('detxImported', data.lines.length))
    } catch {
      toast(t('detxInvalid'))
    }
  } else if (name.endsWith('.rythmo') || name.endsWith('.json')) {
    if (!(await confirmDiscardIfDirty())) return
    try {
      loadProjectData(JSON.parse(await file.text()), window.api.pathForFile(file) || null)
      toast(t('projectLoaded'))
    } catch {
      toast(t('invalidProject'))
    }
  } else if (/\.(mp4|mov|mkv|webm|avi|m4v)$/.test(name)) {
    const p = window.api.pathForFile(file)
    const url = await window.api.fileUrl(p)
    if (url) setVideo(p, url)
  } else if (/\.(wav|mp3|m4a|aac|flac|ogg|opus)$/.test(name)) {
    addExternalAudio(window.api.pathForFile(file))
  } else {
    toast(t('unknownFormat'))
  }
})

// ============================================================ export vidéo
const exp = {
  open: false,
  layout: null, // rects en pixels de sortie : { video:{x,y,w,h}, band:{x,y,w,h} }
  bandPos: 'bottom', // 'bottom' | 'top' : bande en bas ou en haut
  bandFrac: 0.13, // hauteur de bande / hauteur de sortie (réglée par la barre de séparation)
  winSec: 5, // secondes visibles sur la bande exportée (même zoom que l'éditeur)
  drag: false, // glissement de la barre de séparation
  running: false,
  cancelled: false,
  ffFrame: 0,
  previewTime: 0,
  closedResolve: null,
  maxSeconds: 0, // 0 = toute la vidéo (limite réglable pour tests)
}

const expCanvas = $('exportPreview')
const expCtx = expCanvas.getContext('2d')
const PREVIEW_W = 780

const outW = () => Math.max(320, Math.floor(Number($('expW').value) / 2) * 2)
const outH = () => Math.max(180, Math.floor(Number($('expH').value) / 2) * 2)
const expScale = () => expCanvas.width / outW()

// dispose vidéo + bande à partir de la position (haut/bas) et de la fraction de
// hauteur de la bande ; la vidéo est centrée (letterbox) dans la zone restante
function layoutExport() {
  const W = outW()
  const H = outH()
  const bandH = clamp(Math.round(H * exp.bandFrac), 24, H - 24)
  const regionH = H - bandH
  const ar = (video.videoWidth || 16) / (video.videoHeight || 9)
  let vw = W
  let vh = vw / ar
  if (vh > regionH) {
    vh = regionH
    vw = vh * ar
  }
  const regionY = exp.bandPos === 'top' ? bandH : 0
  const bandY = exp.bandPos === 'top' ? 0 : regionH
  exp.layout = {
    video: { x: (W - vw) / 2, y: regionY + (regionH - vh) / 2, w: vw, h: vh },
    band: { x: 0, y: bandY, w: W, h: bandH },
  }
}

// hauteur de bande par défaut = même hauteur visuelle que la bande de l'éditeur.
// On veut le même rapport « hauteur de piste / largeur de bande » dans la sortie que
// dans l'éditeur (cw = largeur de la bande éditeur) → même police ET même écrasement.
function resetExportLayout() {
  const W = outW()
  const H = outH()
  exp.bandFrac = clamp(cw > 0 ? (LANE_H * laneCount() * W) / (cw * H) : 0.09 * laneCount(), 0.06, 0.6)
  layoutExport()
}

function sizeExportPreview() {
  expCanvas.width = PREVIEW_W
  expCanvas.height = Math.round((PREVIEW_W * outH()) / outW())
}

function applyExpPreset() {
  const v = $('expPreset').value
  const custom = v === 'custom'
  $('expW').disabled = !custom
  $('expH').disabled = !custom
  if (!custom) {
    const [w, h] = v.split('x').map(Number)
    $('expW').value = w
    $('expH').value = h
  }
  sizeExportPreview()
  resetExportLayout()
}

function updateWinReadout() {
  $('expWinVal').textContent = t('winVal', Math.round(exp.winSec * 10) / 10)
}

// le slider de zoom de l'export reprend l'échelle log de l'éditeur (SEC_MAX → SEC_MIN)
function syncExpZoomSlider() {
  $('expWin').value = String(Math.log(exp.winSec / SEC_MAX) / Math.log(SEC_MIN / SEC_MAX))
}

// encodeur : GPU détecté (sondé une fois) ou CPU ; préférence persistée
let gpuEncoder = null
let encoderProbed = false

async function populateEncoderSelect() {
  const sel = $('expEnc')
  if (!encoderProbed) {
    sel.innerHTML = `<option>${t('detecting')}</option>`
    sel.disabled = true
    const enc = await window.api.probeEncoder()
    encoderProbed = true
    gpuEncoder = enc && enc !== 'libx264' ? enc : null
  }
  sel.innerHTML = ''
  if (gpuEncoder) {
    const o = document.createElement('option')
    o.value = 'gpu'
    o.textContent = ENCODER_LABELS[gpuEncoder] || gpuEncoder
    sel.appendChild(o)
  }
  const o2 = document.createElement('option')
  o2.value = 'cpu'
  o2.textContent = ENCODER_LABELS.libx264
  sel.appendChild(o2)
  sel.disabled = false
  sel.value = gpuEncoder && exportEncoder === 'gpu' ? 'gpu' : 'cpu'
}

$('expEnc').addEventListener('change', () => {
  exportEncoder = $('expEnc').value === 'cpu' ? 'cpu' : 'gpu'
  pushSettings()
})

// groupe « Contenu » de l'export : plage temporelle selon les boucles cochées
// (sinon toute la vidéo), pistes rythmo cochées, et piste audio choisie.
function exportRange() {
  const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  const loops = project.loops || []
  if (!loops.length || !exp.loopSel || exp.loopSel.size === 0 || exp.loopSel.size === loops.length) {
    return { start: 0, end: dur }
  }
  const sel = loops.filter((l) => exp.loopSel.has(l.id))
  if (!sel.length) return { start: 0, end: dur }
  const start = Math.max(0, Math.min(...sel.map((l) => l.start)))
  const end = Math.min(dur || 1e9, Math.max(...sel.map((l) => l.end)))
  return end > start ? { start, end } : { start: 0, end: dur }
}

// construit les contrôles du groupe « Contenu » à l'ouverture de l'export
function buildExportContent() {
  // pistes rythmo (cases) — toutes cochées par défaut
  exp.tracks = new Set(Array.from({ length: laneCount() }, (_, i) => i))
  const tw = $('expTracks')
  tw.innerHTML = ''
  for (let i = 0; i < laneCount(); i++) {
    const lab = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'; cb.checked = true
    cb.addEventListener('change', () => { cb.checked ? exp.tracks.add(i) : exp.tracks.delete(i) })
    lab.append(cb, document.createTextNode(t('track', i + 1)))
    tw.appendChild(lab)
  }
  // boucles (cases) — toutes cochées = toute la vidéo
  exp.loopSel = new Set((project.loops || []).map((l) => l.id))
  const lw = $('expLoops')
  lw.innerHTML = ''
  if (!project.loops || !project.loops.length) {
    const s = document.createElement('span')
    s.className = 'exp-none'; s.textContent = t('expWholeVideo')
    lw.appendChild(s)
  } else {
    for (const lp of sortedLoops()) {
      const lab = document.createElement('label')
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.checked = true
      cb.addEventListener('change', () => { cb.checked ? exp.loopSel.add(lp.id) : exp.loopSel.delete(lp.id) })
      lab.append(cb, document.createTextNode(lp.name + (lp.type === 'out' ? ' (OUT)' : '')))
      lw.appendChild(lab)
    }
  }
  // piste audio (liste déroulante) — défaut = piste de la vidéo (embarquée par défaut)
  const sel = $('expAudio')
  sel.innerHTML = ''
  const tracks = project.audioTracks || []
  for (const a of tracks) {
    const o = document.createElement('option')
    o.value = a.id
    o.textContent = (a.label || baseName(a.path)) + (a.type === 'file' ? ` (${t('trackExternal')})` : '')
    sel.appendChild(o)
  }
  const def = tracks.find((a) => a.isDefault) || tracks.find((a) => a.type === 'embedded') || tracks[0]
  exp.audioId = def ? def.id : ''
  sel.value = exp.audioId
  sel.disabled = !tracks.length
}

function openExportModal() {
  if (!project.videoPath || !video.videoWidth) {
    toast(t('loadVideoFirst'))
    return
  }
  buildExportContent()
  exp.open = true
  $('expBandPos').value = exp.bandPos
  exp.theme = theme // thème de la bande exportée : celui de l'UI par défaut
  $('expTheme').value = exp.theme
  populateEncoderSelect()
  $('expFps').value = project.fps
  exp.winSec = clamp(secondsVisible, SEC_MIN, SEC_MAX) // hérite du zoom de l'éditeur
  syncExpZoomSlider()
  updateWinReadout()
  if (!$('expPath').value) {
    $('expPath').value = project.videoPath.replace(/\.\w+$/, '') + '-rythmo.mp4'
  }
  $('expStatus').textContent = ''
  $('expBar').style.width = '0%'
  applyExpPreset()
  $('exportModal').classList.remove('hidden')
  requestAnimationFrame(exportPreviewLoop)
}

$('expWin').addEventListener('input', () => {
  exp.winSec = SEC_MAX * Math.pow(SEC_MIN / SEC_MAX, Number($('expWin').value))
  updateWinReadout()
})
$('expTheme').addEventListener('change', () => { exp.theme = $('expTheme').value === 'light' ? 'light' : 'dark' })
$('expAudio').addEventListener('change', () => { exp.audioId = $('expAudio').value })

$('expBrowse').addEventListener('click', async () => {
  const p = await window.api.exportSaveDialog($('expPath').value || undefined)
  if (p) $('expPath').value = p
})

function closeExportModal() {
  exp.open = false
  $('exportModal').classList.add('hidden')
}

$('expPreset').addEventListener('change', applyExpPreset)
$('expW').addEventListener('change', () => { sizeExportPreview(); resetExportLayout() })
$('expH').addEventListener('change', () => { sizeExportPreview(); resetExportLayout() })
$('expReset').addEventListener('click', resetExportLayout)
$('expBandPos').addEventListener('change', () => {
  exp.bandPos = $('expBandPos').value === 'top' ? 'top' : 'bottom'
  layoutExport()
})
$('expClose').addEventListener('click', () => {
  if (exp.running) {
    exp.cancelled = true
    window.api.exportCancel()
  }
  closeExportModal()
})

function exportPreviewLoop() {
  if (!exp.open) return
  const s = expScale()
  const L = exp.layout
  // pendant l'export : préview live qui suit la position d'encodage
  const now = exp.running ? exp.previewTime : video.currentTime || 0
  if (exp.running && !video.seeking && Math.abs(video.currentTime - now) > 0.3) {
    video.currentTime = now
  }
  expCtx.fillStyle = '#000'
  expCtx.fillRect(0, 0, expCanvas.width, expCanvas.height)

  expCtx.drawImage(video, L.video.x * s, L.video.y * s, L.video.w * s, L.video.h * s)

  const winSec = Math.max(1, exp.winSec)
  expCtx.save()
  expCtx.translate(L.band.x * s, L.band.y * s)
  expCtx.beginPath()
  expCtx.rect(0, 0, L.band.w * s, L.band.h * s)
  expCtx.clip()
  renderBand(expCtx, now, L.band.w * s, L.band.h * s, (L.band.w * s) / winSec, { ruler: false, wave: false, handles: false, theme: BAND_THEMES[exp.theme || 'dark'], tracks: exp.tracks })
  expCtx.restore()

  // barre de séparation glissable entre la vidéo et la bande (masquée pendant l'export)
  if (!exp.running) {
    const dy = dividerOutY() * s
    expCtx.strokeStyle = '#ffffffcc'
    expCtx.lineWidth = 2
    expCtx.beginPath()
    expCtx.moveTo(0, dy)
    expCtx.lineTo(expCanvas.width, dy)
    expCtx.stroke()
    expCtx.fillStyle = '#ffffff'
    expCtx.fillRect(expCanvas.width / 2 - 16, dy - 3, 32, 6)
    expCtx.lineWidth = 1
  }
  requestAnimationFrame(exportPreviewLoop)
}

// frontière (coords de sortie) entre la zone vidéo et la bande
function dividerOutY() {
  const L = exp.layout
  return exp.bandPos === 'bottom' ? L.band.y : L.band.y + L.band.h
}

// Y de la souris en coordonnées de sortie — via rect.height (la taille CSS affichée
// du canvas diffère de sa résolution interne, d'où la hitbox décalée auparavant)
function expPointerOutY(e) {
  const rc = expCanvas.getBoundingClientRect()
  return rc.height ? ((e.clientY - rc.top) / rc.height) * outH() : 0
}
function nearDivider(e) {
  const rc = expCanvas.getBoundingClientRect()
  const dividerCssY = (dividerOutY() / outH()) * rc.height
  return Math.abs((e.clientY - rc.top) - dividerCssY) < 10
}

expCanvas.addEventListener('pointerdown', (e) => {
  if (exp.running) return
  if (nearDivider(e)) {
    expCanvas.setPointerCapture(e.pointerId)
    exp.drag = true
  }
})

expCanvas.addEventListener('pointermove', (e) => {
  if (!exp.drag) {
    expCanvas.style.cursor = !exp.running && nearDivider(e) ? 'ns-resize' : 'default'
    return
  }
  const H = outH()
  const outY = expPointerOutY(e)
  const bandH = exp.bandPos === 'bottom' ? H - outY : outY
  exp.bandFrac = clamp(bandH / H, 0.06, 0.6)
  layoutExport()
})

const endExpDrag = () => { exp.drag = false }
expCanvas.addEventListener('pointerup', endExpDrag)
expCanvas.addEventListener('pointercancel', endExpDrag)

window.api.onExportProgress((n) => { exp.ffFrame = n })
window.api.onExportClosed((code, err) => {
  if (exp.closedResolve) exp.closedResolve({ code, err })
})

const ENCODER_LABELS = {
  h264_nvenc: 'GPU NVIDIA (NVENC)',
  h264_qsv: 'GPU Intel (QuickSync)',
  h264_amf: 'GPU AMD (AMF)',
  libx264: 'CPU (x264)',
}

async function runExport(outPathOverride) {
  if (exp.running) return
  let outPath = typeof outPathOverride === 'string' ? outPathOverride : $('expPath').value.trim()
  if (!outPath) {
    outPath = await window.api.exportSaveDialog()
    if (!outPath) return
    $('expPath').value = outPath
  }
  if (!/\.mp4$/i.test(outPath)) {
    outPath += '.mp4'
    $('expPath').value = outPath
  }

  const W = outW()
  const H = outH()
  const fps = clamp(Number($('expFps').value) || project.fps, 10, 120)
  const winSec = Math.max(1, exp.winSec)
  const L = JSON.parse(JSON.stringify(exp.layout))
  // groupe « Contenu » : plage temporelle (boucles), pistes rythmo et piste audio
  const range = exportRange()
  let startT = range.start
  let dur = range.end - range.start
  if (exp.maxSeconds > 0) dur = Math.min(exp.maxSeconds, dur)
  const total = Math.ceil(dur * fps)
  const trackSet = exp.tracks // pistes rythmo incluses

  const bw = Math.max(2, Math.round(L.band.w / 2) * 2)
  const bh = Math.max(2, Math.round(L.band.h / 2) * 2)
  // piste audio choisie (avec son offset gravé) ; aucune → repli sur la 1re piste du conteneur
  const at = (project.audioTracks || []).find((a) => a.id === exp.audioId)
  const audio = at && (at.type !== 'file' || at.path) ? [{
    path: at.type === 'file' ? at.path : project.videoPath,
    aIndex: at.type === 'file' ? 0 : at.index,
    offset: at.offset || 0,
    exported: true,
    isDefault: true,
  }] : []
  const r = await window.api.exportStart({
    fps, W, H, duration: dur, startTime: startT, layout: L, bandW: bw, bandH: bh,
    videoPath: project.videoPath, outPath, audio,
    encoder: $('expEnc').value === 'cpu' ? 'cpu' : 'gpu',
  })
  if (r.error) {
    toast(r.error)
    return
  }
  const encLabel = ENCODER_LABELS[r.encoder] || r.encoder

  exp.running = true
  exp.cancelled = false
  exp.ffFrame = 0
  exp.previewTime = 0
  exp.drag = false
  $('expGo').disabled = true
  $('expClose').textContent = t('cancel')
  video.pause()
  const resumeTime = video.currentTime

  // on ne rend que la bande (RGBA brut) — ffmpeg compose et encode le reste
  const oc = document.createElement('canvas')
  oc.width = bw
  oc.height = bh
  const octx = oc.getContext('2d', { willReadFrequently: true })

  const closed = new Promise((res) => { exp.closedResolve = res })

  let ok = true
  for (let i = 0; i < total; i++) {
    if (exp.cancelled) { ok = false; break }
    const tt = startT + i / fps
    renderBand(octx, tt, bw, bh, bw / winSec, { ruler: false, wave: false, handles: false, theme: BAND_THEMES[exp.theme || 'dark'], tracks: trackSet })
    exp.previewTime = tt
    const sent = await window.api.exportFrame(octx.getImageData(0, 0, bw, bh).data.buffer)
    if (!sent) { ok = false; break }

    if (i % 10 === 0 || i === total - 1) {
      $('expBar').style.width = `${Math.round((exp.ffFrame / total) * 100)}%`
      $('expStatus').textContent = t('statusRender', i + 1, total, exp.ffFrame, encLabel)
    }
  }

  // les dernières frames s'encodent après la fin du pipe
  await window.api.exportEnd()
  const progressTimer = setInterval(() => {
    $('expBar').style.width = `${Math.round((exp.ffFrame / total) * 100)}%`
    $('expStatus').textContent = t('statusEncode', exp.ffFrame, total, encLabel)
  }, 300)
  const { code, err } = ok ? await closed : { code: -1, err: '' }
  clearInterval(progressTimer)

  exp.running = false
  exp.closedResolve = null
  $('expGo').disabled = false
  $('expClose').textContent = t('close')
  video.currentTime = resumeTime

  if (exp.cancelled) {
    $('expStatus').textContent = t('expCancelled')
  } else if (code === 0) {
    $('expBar').style.width = '100%'
    $('expStatus').textContent = t('expDone')
    toast(t('exported', outPath.replace(/^.*[\\/]/, '')))
  } else {
    $('expStatus').textContent = t('expFailed')
    if (err) console.error('ffmpeg:', err)
    toast(t('expFailedToast'))
  }
}

$('expGo').addEventListener('click', runExport)

// ============================================================ main loop
function loop() {
  $('timecode').textContent = formatTc(effectiveTime(), project.fps)
  btnPlay.classList.toggle('playing', !video.paused)
  if (activeTab === 'tracks') updateTracksPlayhead()
  else draw()
  requestAnimationFrame(loop)
}

// ============================================================ init
// Les réglages persistants (settings.ini) sont chargés depuis le process
// principal — qui a déjà construit le menu avec les mêmes valeurs.
;(async () => {
  const st = await window.api.getSettings()
  lang = st.lang === 'en' ? 'en' : 'fr'
  autosaveOn = !!st.autosave
  showWave = st.wave !== false
  showVideoInfo = !!st.info
  exportEncoder = st.encoder === 'cpu' ? 'cpu' : 'gpu'
  setTheme(st.theme)
  addCharacter()
  undoStack = []
  redoStack = []
  syncUndoMenu()
  setClean()
  applyLang()
  applyBandHeight() // hauteur de bande = nb de pistes × hauteur de piste fixe
  requestAnimationFrame(loop)
})()
