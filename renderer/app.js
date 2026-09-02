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

// notification de mise à jour : bannière jaune persistante (clic = ouvre les Releases),
// reste affichée jusqu'à ce qu'on la ferme via la croix
window.api.onUpdateAvailable((v) => {
  $('updateMsg').textContent = t('updateAvailable', v)
  $('updateBanner').classList.remove('hidden')
})
$('updateBanner').addEventListener('click', () => window.api.openReleases())
$('updateClose').addEventListener('click', (e) => {
  e.stopPropagation()
  $('updateBanner').classList.add('hidden')
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
  return { version: 2, videoPath: null, fps: 25, tracks: DEFAULT_TRACKS, characters: [], lines: [], loops: [], plans: [], audioTracks: [], defaultFont: null, fonts: [], cues: [], bookmarks: [], playhead: 0, muteChars: [], voiceTrackId: null, recordings: [], recMuted: [], voiceFxOn: false }
}

// Boucles (= scènes, unité de travail à l'enregistrement). Durée de référence du
// doublage FR : un segment OUT doit rester long (≥ 30 s) et d'un seul tenant. Une
// scène normale peut durer autant que voulu — on ne signale pas les scènes longues.
const LOOP_OUT_MIN_SEC = 30
const LOOP_DEFAULT_SEC = 40 // longueur par défaut d'une nouvelle boucle

// fenêtre détachée (index.html?detached=1) : mode « rendu seul » piloté par la
// fenêtre principale via IPC — pas d'audio, pas de forme d'onde, pas d'édition
const DETACHED = new URLSearchParams(location.search).has('detached')

let project = newProject()
let projectPath = null
let dirty = false
let selectedCharId = null
let selectedIds = new Set() // sélection multiple ; l'inspecteur n'apparaît que pour 1 réplique
const singleSelected = () => (selectedIds.size === 1 ? getLine([...selectedIds][0]) : null)
// Zoom exprimé en SECONDES VISIBLES sur la largeur de la bande ; pxPerSec en découle
// (recomputePps) selon la largeur courante. Dézoom max = 5 s, défaut = 3 s, zoom max = 1,8 s.
let secondsVisible = 3
const SEC_MAX = 5 // dézoomé au maximum
const SEC_MIN = 1.8 // zoomé au maximum
let pxPerSec = 120
function recomputePps() {
  if (cw > 0) pxPerSec = cw / clamp(secondsVisible, SEC_MIN, SEC_MAX)
}

// Hauteur de piste FIXE : une piste a toujours la même hauteur. Moins de pistes =
// bande plus courte en bas (la vidéo récupère la place).
const LANE_H = 76
const NEW_LINE_DUR = 0.25 // durée (s) par défaut d'une nouvelle réplique (1/4 de 1 s)
const bandHeightFor = (n) => Math.round(RULER_H + n * LANE_H)

// Panneau du bas redimensionnable. Une poignée unique en haut du dock (#panelResizer,
// au-dessus du transport) règle la hauteur TOTALE du bloc bas, identique sur les onglets
// Rythmo et Pistes. La zone bande/pistes est l'élément flexible qui absorbe l'espace.
// panelH : hauteur totale choisie pendant la session par glisser (px) ; null = « auto » →
// hauteur max (toutes les pistes rythmo visibles). Remis à null (donc max) à chaque chargement
// de projet et à chaque changement du nombre de pistes ; non persisté entre les sessions.
let panelH = null
let chromeH = 120 // hauteur transport + tabBar + inspecteur (remesurée)
const PANEL_MIN_CONTENT = RULER_H + LANE_H // au moins une piste visible
const bandContentH = () => bandHeightFor(laneCount())
function measureChrome() {
  const tr = transport.offsetHeight, tb = tabBar.offsetHeight
  // l'inspecteur est masqué sur l'onglet Pistes : on mémorise sa hauteur quand il est visible
  if (!inspector.classList.contains('hidden') && inspector.offsetHeight) measureChrome._ins = inspector.offsetHeight
  const ins = inspector.classList.contains('hidden') ? (measureChrome._ins || 44) : inspector.offsetHeight
  // la barre de progression (#seekBar, ajoutée en 2.7.1) est un enfant du dock au-dessus du
  // transport : sa hauteur doit entrer dans le chrome, sinon autoPanelH la sous-estime et le
  // drag-up max laisse une barre de défilement verticale au niveau des pistes. 0 si masquée.
  const seek = $('seekBar')
  const sb = seek.classList.contains('hidden') ? 0 : seek.offsetHeight
  if (tr && tb) chromeH = tr + tb + ins + sb
}
// hauteur « naturelle » du dock = chrome + toutes les pistes rythmo visibles. Même référence
// sur les deux onglets : l'onglet Pistes garde donc EXACTEMENT la hauteur de l'onglet Rythmo
// (son contenu défile si besoin).
const autoPanelH = () => chromeH + bandContentH()
// on ne peut pas agrandir au-delà de « toutes les pistes visibles », ni au-delà de la fenêtre
const panelMax = () => Math.max(chromeH + PANEL_MIN_CONTENT, Math.min(autoPanelH(), window.innerHeight - 140))
const effectivePanelH = () => clamp(panelH == null ? autoPanelH() : panelH, chromeH + PANEL_MIN_CONTENT, panelMax())
function setPanelHeight(h) {
  measureChrome()
  panelH = clamp(Math.round(h), chromeH + PANEL_MIN_CONTENT, panelMax())
  applyBandHeight()
}

function applyBandHeight() {
  // canvas = hauteur de contenu complète (hauteur de piste fixe préservée). Le dock prend une
  // hauteur explicite ; la zone bande/pistes (flex:1) absorbe le reste → même hauteur totale
  // quel que soit l'onglet, et défilement vertical si le contenu déborde.
  measureChrome()
  canvas.style.height = `${bandContentH()}px`
  canvas.style.width = '100%'
  const H = effectivePanelH()
  bottomPanel.style.flex = `0 0 ${H}px`
  bottomPanel.style.height = `${H}px`
  resizeCanvas() // met à jour cw/ch immédiatement
  if (activeTab === 'tracks') resizeTracksCanvas()
}

const video = $('video')
const canvas = $('band')
const bottomPanel = $('bottomPanel')
const transport = $('transport')
const tabBar = $('tabBar')
const inspector = $('inspector')

// poignée de redimensionnement du dock : glisser vers le haut agrandit le panneau du bas
// (la vidéo rend la place), vers le bas le réduit. Fonctionne sur les deux onglets.
const panelResizer = $('panelResizer')
let panelResizeDrag = null
panelResizer.addEventListener('pointerdown', (e) => {
  panelResizer.setPointerCapture(e.pointerId)
  panelResizeDrag = { y0: e.clientY, h0: effectivePanelH() }
  e.preventDefault()
})
panelResizer.addEventListener('pointermove', (e) => {
  if (!panelResizeDrag) return
  setPanelHeight(panelResizeDrag.h0 + (panelResizeDrag.y0 - e.clientY))
})
const endPanelResize = (e) => {
  if (!panelResizeDrag) return
  panelResizeDrag = null
  panelResizer.releasePointerCapture(e.pointerId)
}
panelResizer.addEventListener('pointerup', endPanelResize)
panelResizer.addEventListener('pointercancel', endPanelResize)
// fenêtre redimensionnée : re-clamp (la hauteur max dépend de la fenêtre) + remesure du chrome
window.addEventListener('resize', applyBandHeight)
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
    planMark: '#e8a13a', // marqueur de changement de plan (flèche vers le bas)
    symbol: '#ffd24a', // signes de détection posés sur le texte
  },
  light: {
    bg: '#f6f2e9', lane: '#ece6d8', grid: '#d8d1c0',
    rulerBg: '#e9e3d4', tick: '#a59d89', tickText: '#7c7565',
    wave: 'rgba(58, 94, 190, 0.15)', playhead: '#d23a30',
    handle: '#2b2a25', handleAccent: '#3c5d96', selStroke: '#2b2a25cc',
    markIn: '#2f9e44', markOut: '#d23a30',
    planMark: '#c47d1a',
    symbol: '#a05a00',
  },
}
let theme = 'dark'
const bandPal = () => BAND_THEMES[theme]

// couleur de texte lisible sur un fond donné : on prend noir ou blanc selon le
// meilleur contraste réel (WCAG) — noir dès que le fond est clair, blanc sinon.
function textOn(hex) {
  const h = String(hex || '').replace('#', '')
  if (h.length < 6) return '#fff'
  const lin = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  const contrastBlack = (L + 0.05) / 0.05
  const contrastWhite = 1.05 / (L + 0.05)
  return contrastBlack >= contrastWhite ? '#000' : '#fff'
}

// ---------- polices personnalisées (TTF/OTF) ----------
// Les polices sont embarquées dans le projet (project.fonts = [{ name, data(base64),
// ext }]) pour rester portables et rendre à l'identique à l'export. À l'ouverture, on
// ré-enregistre chaque police comme FontFace. line.font surcharge project.defaultFont
// qui surcharge la police interne ("Segoe UI").
const BAND_FALLBACK = '"Segoe UI", sans-serif'
const registeredFonts = new Set() // noms déjà ajoutés à document.fonts cette session

// polices libres embarquées avec l'app (déclarées en @font-face dans style.css) :
// disponibles d'office dans les sélecteurs, sans être stockées dans le projet
const BUNDLED_FONTS = ['Inter', 'Oswald', 'Comfortaa', 'Anton']
// noms de toutes les polices connues (embarquées app + embarquées projet)
const allFontNames = () => [...BUNDLED_FONTS, ...((project.fonts || []).map((f) => f.name))]
// force le décodage des polices embarquées au démarrage (rendu canvas immédiat)
function loadBundledFonts() {
  for (const name of BUNDLED_FONTS) {
    try { document.fonts.load(`700 24px "${name}"`) } catch {}
  }
}

async function registerFont(name, dataB64, ext) {
  if (!name || registeredFonts.has(name)) return registeredFonts.has(name)
  const mime = ext === 'otf' ? 'font/otf' : ext === 'woff2' ? 'font/woff2' : ext === 'woff' ? 'font/woff' : 'font/ttf'
  try {
    const ff = new FontFace(name, `url(data:${mime};base64,${dataB64})`)
    await ff.load()
    document.fonts.add(ff)
    registeredFonts.add(name)
    return true
  } catch {
    return false
  }
}

async function registerAllFonts() {
  for (const f of project.fonts || []) await registerFont(f.name, f.data, f.ext)
}

// chaîne CSS de police pour le rendu canvas d'une réplique (surcharge → défaut → interne)
function bandFontFamily(line) {
  const fam = (line && line.font) || project.defaultFont
  return fam ? `"${fam.replace(/"/g, '')}", ${BAND_FALLBACK}` : BAND_FALLBACK
}

// remplit les deux sélecteurs de police (défaut global + par réplique) à partir du
// registre du projet ; valeur '' = police par défaut, '__load__' = charger un fichier
function populateFontSelects() {
  const fonts = project.fonts || []
  const fill = (sel, current, defaultLabel) => {
    if (!sel) return
    sel.innerHTML = ''
    const add = (val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; sel.appendChild(o) }
    add('', defaultLabel)
    for (const name of BUNDLED_FONTS) add(name, name) // polices libres embarquées
    for (const f of fonts) add(f.name, f.name)         // polices propres au projet
    add('__load__', t('fontLoad'))
    sel.value = allFontNames().includes(current) ? current : ''
  }
  fill($('defFont'), project.defaultFont || '', t('fontDefaultGlobal'))
  const line = selectedIds && selectedIds.size === 1 ? project.lines.find((l) => selectedIds.has(l.id)) : null
  fill($('insFont'), line ? (line.font || '') : '', t('fontDefault'))
}

// ouvre un fichier TTF/OTF, l'enregistre dans le projet + comme FontFace ; renvoie le
// nom (ou null si annulé/échec). Évite les doublons de nom.
async function loadFontFile() {
  const f = await window.api.pickFont()
  if (!f || !f.data) return null
  let name = f.name || 'Police'
  if (!(project.fonts || []).some((x) => x.name === name) && !registeredFonts.has(name)) {
    const ok = await registerFont(name, f.data, f.ext)
    if (!ok) { toast(t('fontLoadFail')); return null }
    project.fonts.push({ name, data: f.data, ext: f.ext })
    markDirty()
  } else {
    await registerFont(name, f.data, f.ext) // déjà présent : s'assure qu'il est chargé
  }
  return name
}

function setTheme(th) {
  theme = th === 'light' ? 'light' : 'dark'
  document.body.classList.toggle('light', theme === 'light')
}

let exportEncoder = 'gpu' // préférence persistée ([export] encoder dans settings.ini)
let discordOn = false // Discord Rich Presence (Affichage → Discord Rich Presence)
let showSubs = false // sous-titres « classiques » superposés à l'aperçu vidéo (Affichage → Sous-titres)
let autofocusText = true // focus du champ texte à la création d'une réplique (Édition → Éditer le texte…)

// focus + sélection du champ texte de l'inspecteur après création d'une réplique
function focusNewLineText() {
  if (!autofocusText) return
  ins.text.focus()
  ins.text.select()
}

// pousse tous les réglages au process principal : persistance settings.ini + menu
function pushSettings() {
  window.api.setLang({ lang, theme, wave: showWave, info: showVideoInfo, subs: showSubs, autosave: autosaveOn, encoder: exportEncoder, discord: discordOn, autofocus: autofocusText, seekbar: showSeekBar })
}

// présence Discord : titre du projet + nombre de répliques (poussé sur les évènements clés)
function updateDiscordActivity() {
  if (!discordOn) return
  const name = projectPath ? projectPath.replace(/^.*[\\/]/, '').replace(/\.(rythmo|json)$/i, '') : t('untitled')
  window.api.discordActivity({ details: name, state: t('discordLines', project.lines.length) })
}

function markDirty() {
  detachedQueueState() // la fenêtre détachée suit les modifications du projet
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
  document.title = `LibreRythmo - ${name}${dirty ? ' •' : ''}${auto}`
}

// ---------- enregistrement automatique (Fichier → Enregistrement automatique)
let autosaveOn = false // initialisé depuis settings.ini

function scheduleAutosave() {
  if (!autosaveOn || !projectPath) return
  clearTimeout(scheduleAutosave._t)
  scheduleAutosave._t = setTimeout(async () => {
    if (!autosaveOn || !projectPath || !dirty || exp.running) return
    const p = await window.api.saveProject(projectJson(), projectPath)
    if (p) setClean()
  }, 1500)
}

// ---------- annuler / rétablir (10 étapes, instantanés JSON du contenu)
const UNDO_MAX = 10
let undoStack = []
let redoStack = []
let undoCoalesce = false // les pushUndo d'une même opération (même tick) ne comptent qu'une fois

const undoSnap = () => JSON.stringify({ tracks: project.tracks, characters: project.characters, lines: project.lines, loops: project.loops, plans: project.plans, audioTracks: project.audioTracks, defaultFont: project.defaultFont, cues: project.cues, bookmarks: project.bookmarks })

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
  project.plans = d.plans || []
  project.cues = d.cues || []
  project.bookmarks = d.bookmarks || []
  if (d.audioTracks) project.audioTracks = d.audioTracks
  project.defaultFont = d.defaultFont || null
  waveOffset = (activeAudioTrack()?.offset) || 0 // suit l'offset restauré de la piste active
  syncPlaybackAudio() // la lecture suit la piste/le décalage restaurés
  if (!getChar(selectedCharId)) selectedCharId = project.characters[0]?.id || null
  selectedIds = new Set([...selectedIds].filter((id) => getLine(id)))
  populateFontSelects()
  renderChars()
  applyBandHeight()
  buildInsTrackOptions()
  buildLineFilterOptions()
  refreshInspector()
  refreshTrackCountUI()
  renderLoopsPanel()
  renderPlansPanel()
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
  $('dropBrowseLbl').textContent = t('dropBrowseLbl')
  $('ytTitle').textContent = t('ytTitle')
  $('ytGrpSrc').textContent = t('ytGrpSrc')
  $('ytLblUrl').textContent = t('ytLblUrl')
  $('ytLblQuality').textContent = t('ytLblQuality')
  $('ytLblDest').textContent = t('lblDest')
  $('ytLblTrim').textContent = t('ytLblTrim')
  $('ytBrowse').textContent = t('expBrowse')
  $('ytClose').textContent = t('close')
  if (ytSt.phase !== 'trim') $('ytGo').textContent = t('ytGoImport')

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
  $('btnSymbols').textContent = t('symbolsBtn')
  $('btnSymbols').title = t('symbolsTitle')
  buildSymbolPop()
  $('btnAdr').title = t('adrTitle')
  buildCuePop()
  updateRecUI()
  $('trTitle').textContent = t('trTitle')
  $('trHint').textContent = t('trHint')
  $('trInLabel').textContent = t('trInLabel')
  $('trModelLabel').textContent = t('trModelLabel')
  $('trSpeakersLabel').textContent = t('trSpeakersLabel')
  $('trLangLabel').textContent = t('trLangLabel')
  $('trOpenSettings').textContent = t('aiOpenSettings')
  $('trClose').textContent = t('close')
  $('trGo').textContent = t('trGoBtn')
  $('sepModalTitle').textContent = t('sepModalTitle')
  $('sepInLabel').textContent = t('sepInLabel')
  $('sepRunModelLabel').textContent = t('sepRunModelLabel')
  $('sepOutNameLabel').textContent = t('sepOutNameLabel')
  $('sepOutDirLabel').textContent = t('sepOutDirLabel')
  $('sepOutBrowse').textContent = t('sepOutBrowse')
  $('sepOpenSettings').textContent = t('aiOpenSettings')
  $('sepCloseBtn').textContent = t('close')
  $('sepGo').textContent = t('sepGoBtn')
  $('setTitle').textContent = t('setTitle')
  $('setCapLegend').textContent = t('setCapLegend')
  $('setCapApiLabel').textContent = t('setCapApiLabel')
  $('setCapDevLabel').textContent = t('setCapDevLabel')
  $('setOutDevLabel').textContent = t('setOutDevLabel')
  $('recOffLabel').textContent = t('recOffLabel')
  $('recOffLabel').parentElement.title = t('recOffTitle')
  $('outTest').textContent = t(outTestState ? 'outTestStop' : 'outTestBtn')
  $('setTrLegend').textContent = t('setTrLegend')
  $('setTrActiveLabel').textContent = t('setActiveLabel')
  $('setSepLegend').textContent = t('setSepLegend')
  $('setSepActiveLabel').textContent = t('setActiveLabel')
  $('setClose').textContent = t('close')
  $('btnTogglePanel').textContent = t('panelToggle')
  $('btnTogglePanel').title = t('panelToggleTitle')
  $('btnToggleLines').textContent = t('linesTitle')
  $('btnToggleLines').title = t('linesToggleTitle')
  $('btnToggleLoops').textContent = t('loopsTitle')
  $('btnToggleLoops').title = t('loopsToggleTitle')
  $('plansTitle').textContent = t('plansTitle')
  $('btnTogglePlans').textContent = t('plansTitle')
  $('btnTogglePlans').title = t('plansToggleTitle')
  $('plansEmpty').textContent = t('plansEmpty')
  $('btnAddPlan').textContent = t('addPlan')
  $('btnAddPlan').title = t('addPlanTitle')
  $('btnDetectPlans').textContent = t('detectPlans')
  $('btnDetectPlans').title = t('detectPlansTitle')
  $('detTitle').textContent = t('detTitle')
  $('detHint').textContent = t('detHint')
  $('detSensLabel').textContent = t('detSensLabel')
  $('detGo').textContent = t('detGo')
  $('detCancel').textContent = t('close')
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
  $('tabRec').textContent = t('tabRec')
  $('recEmptyMain').textContent = t('recEmptyMain')
  $('recEmptySub').textContent = t('recEmptySub')
  if (activeTab === 'rec') renderRecTab()
  $('btnImportAudio').textContent = t('importAudio')
  $('btnDubLabel').textContent = t('dubBtn')
  $('btnDub').title = t('dubBtnTitle')
  $('tracksEmptyMain').textContent = t('tracksEmptyMain')
  $('tracksEmptySub').textContent = t('tracksEmptySub')
  if (activeTab === 'tracks') renderTracks()
  // mode lecture plein écran
  $('btnPlayer').title = t('playerBtn')
  $('pcExit').title = t('pcExitTitle')
  $('pcDetach').title = t('pcDetachTitle')
  $('recVu').title = t('recVuTitle')
  $('pcPlay').title = t('pcPlayTitle')
  $('pcPrev').title = t('pcPrevTitle')
  $('pcNext').title = t('pcNextTitle')
  $('pcLoop').title = t('pcLoopTitle')
  $('pcMute').title = t('pcMuteTitle')
  $('pcZoomWrap').title = t('pcZoomTitle')
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
  ins.font.title = t('insFont')
  $('defFont').title = t('defFontTitle')
  $('insMultiChar').title = t('multiCharTitle')
  $('insMultiFont').title = t('multiFontTitle')
  $('insMultiTrack').title = t('multiTrackTitle')
  $('insMultiVoiceOff').title = t('multiVoiceOffTitle')
  $('insMultiVoiceOff').textContent = t('insVoiceOff')
  populateFontSelects()
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
  $('insDel').title = t('insDelTitle')

  // export
  $('expTitle').textContent = t('expTitle')
  $('lblRes').textContent = t('lblRes')
  $('optCustom').textContent = t('optCustom')
  $('lblFps').textContent = t('lblFps')
  $('optFpsCustom').textContent = t('optFpsCustom')
  if (exp.open) syncFpsModeUI()
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
  $('optBandNone').textContent = t('optBandNone')
  $('lblEnc').textContent = t('lblEnc')
  $('lblSpeed').textContent = t('lblSpeed')
  $('lblSpeedWrap').title = t('speedTitle')
  $('expReset').textContent = t('expReset')
  $('lblDest').textContent = t('lblDest')
  $('tkTitle').textContent = t('tkTitle')
  $('tkGrpSrc').textContent = t('tkGrpSrc')
  $('tkLblSource').textContent = t('tkLblSource')
  $('tkOptRaw').textContent = t('tkOptRaw')
  $('tkOptFx').textContent = t('tkOptFx')
  $('tkLblDetached').textContent = t('tkLblDetached')
  $('tkLblDest').textContent = t('lblDest')
  $('tkPath').placeholder = t('tkPathPh')
  $('tkBrowse').textContent = t('expBrowse')
  $('tkClose').textContent = t('close')
  $('tkGo').textContent = t('tkGoBtn')
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

// renommage en place d'un libellé de liste (personnages / scènes / plans) : remplace
// le <span> du nom par un champ, commit au blur/Entrée, annule à Échap, puis re-rend.
function inlineRename(nmSpan, currentValue, onCommit, rerender) {
  const inp = document.createElement('input')
  inp.type = 'text'
  inp.className = 'nm-input'
  inp.value = currentValue
  inp.spellcheck = false
  nmSpan.replaceWith(inp)
  inp.focus()
  inp.select()
  let cancelled = false
  const done = () => {
    const nv = inp.value.trim()
    if (!cancelled && nv && nv !== currentValue) onCommit(nv)
    rerender()
  }
  inp.addEventListener('blur', done)
  inp.addEventListener('click', (ev) => ev.stopPropagation())
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') inp.blur()
    if (ev.key === 'Escape') { cancelled = true; inp.blur() }
    ev.stopPropagation()
  })
}

// crée un bouton ✎ (renommer) ou ✕ (supprimer) au style des lignes Personnages
function rowIconButton(kind, title, onClick) {
  const b = document.createElement('button')
  b.className = kind === 'edit' ? 'edit' : 'x'
  b.textContent = kind === 'edit' ? '✎' : '✕'
  b.title = title
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
  return b
}


// Tier B : fusion de personnages — toutes les répliques du source passent à la
// cible, puis le source est supprimé (utile après un import où un rôle apparaît
// en double sous deux noms). Undoable.
function mergeCharacter(srcId, dstId) {
  if (!srcId || !dstId || srcId === dstId) { renderChars(); return }
  if (!getChar(srcId) || !getChar(dstId)) return
  pushUndo()
  for (const l of project.lines) if (l.characterId === srcId) l.characterId = dstId
  project.characters = project.characters.filter((c) => c.id !== srcId)
  if (selectedCharId === srcId) selectedCharId = dstId
  renderChars()
  refreshInspector()
  renderLinesLog()
  markDirty()
  toast(t('charMerged'))
}

function renderChars() {
  // outline du groupe « + Réplique | + Réaction » à la couleur du personnage sélectionné
  // (vers quelle voix part la prochaine réplique) ; bordure neutre si aucun personnage
  const sel = getChar(selectedCharId)
  const addGroup = $('btnAddLine').closest('.seg-group')
  if (addGroup) addGroup.style.borderColor = sel ? sel.color : ''
  // badge « personnage sélectionné » (premier segment du groupe) : fond = couleur du
  // perso, nom en texte lisible ; taille fixe + ellipsis (ne décale pas l'interface)
  const badge = $('curCharBadge')
  if (badge) {
    badge.textContent = sel ? sel.name : '—'
    badge.style.background = sel ? sel.color : 'transparent'
    badge.style.color = sel ? textOn(sel.color) : 'var(--dim)'
    badge.title = sel ? sel.name : ''
  }

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
      if (c.id === selectedCharId) { const g = $('btnAddLine').closest('.seg-group'); if (g) g.style.borderColor = c.color }
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

    // piste préférée : P1–P4 même si la piste n'est pas affichée (fallback auto
    // au placement par priorité tant qu'elle n'existe pas), « – » = automatique
    const trk = document.createElement('select')
    trk.className = 'pref'
    trk.title = t('charPrefTrack')
    const auto = document.createElement('option')
    auto.value = ''
    auto.textContent = '–'
    trk.appendChild(auto)
    for (let i = 0; i < MAX_TRACKS; i++) {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = t('charPrefOpt', i + 1)
      trk.appendChild(o)
    }
    trk.value = c.prefTrack != null ? String(c.prefTrack) : ''
    trk.classList.toggle('set', trk.value !== '')
    trk.addEventListener('click', (e) => e.stopPropagation())
    trk.addEventListener('change', () => {
      pushUndo()
      if (trk.value === '') delete c.prefTrack
      else c.prefTrack = Number(trk.value)
      trk.classList.toggle('set', trk.value !== '')
      markDirty()
    })

    // fusionner ce personnage dans un autre (choix par liste déroulante inline)
    const mg = document.createElement('button')
    mg.className = 'edit'
    mg.textContent = '⇢'
    mg.title = t('charMerge')
    mg.addEventListener('click', (e) => {
      e.stopPropagation()
      const others = project.characters.filter((k) => k.id !== c.id)
      if (!others.length) { toast(t('charMergeNone')); return }
      const msel = document.createElement('select')
      msel.className = 'nm-input'
      const ph = document.createElement('option')
      ph.value = ''; ph.textContent = t('charMergeInto')
      msel.appendChild(ph)
      for (const o of others) {
        const op = document.createElement('option')
        op.value = o.id; op.textContent = o.name
        msel.appendChild(op)
      }
      nm.replaceWith(msel)
      msel.focus()
      msel.addEventListener('click', (ev) => ev.stopPropagation())
      msel.addEventListener('change', () => mergeCharacter(c.id, msel.value))
      msel.addEventListener('blur', () => setTimeout(() => { if (document.body.contains(msel)) renderChars() }, 150))
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

    row.append(sw, nm, trk, mg, edit, x)
    row.addEventListener('click', () => {
      selectedCharId = c.id
      renderChars()
    })
    list.appendChild(row)
  }
  // la sélection est un mécanisme unique : on répercute sur l'onglet Enregistrement
  if (activeTab === 'rec') { updateRecCharBadge(); renderRecCharList() }
}

$('btnTogglePanel').addEventListener('click', () => {
  const panel = $('sidePanel')
  panel.classList.toggle('hidden')
  $('btnTogglePanel').classList.toggle('active', !panel.classList.contains('hidden'))
})


// ============================================================ Tier B — zoom sur l'image
// Zoom/pan de la vidéo de l'éditeur (transitoire, non enregistré) : Ctrl+molette
// pour zoomer sur l'image, glisser pour déplacer, double-clic pour réinitialiser.
// Utile pour inspecter les mouvements de bouche (détection).
const imgZoom = { scale: 1, x: 0, y: 0 }
function clampImgPan() {
  const w = video.clientWidth, h = video.clientHeight
  const mx = Math.max(0, (w * (imgZoom.scale - 1)) / 2)
  const my = Math.max(0, (h * (imgZoom.scale - 1)) / 2)
  imgZoom.x = clamp(imgZoom.x, -mx, mx)
  imgZoom.y = clamp(imgZoom.y, -my, my)
}
function applyImgZoom() {
  const on = imgZoom.scale > 1.001
  video.style.transform = on ? `translate(${imgZoom.x}px, ${imgZoom.y}px) scale(${imgZoom.scale})` : ''
  video.style.cursor = on ? 'grab' : ''
}
function resetImgZoom() { imgZoom.scale = 1; imgZoom.x = 0; imgZoom.y = 0; applyImgZoom() }

$('videoWrap').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !video.videoWidth) return
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  imgZoom.scale = clamp(imgZoom.scale * factor, 1, 6)
  clampImgPan()
  applyImgZoom()
}, { passive: false })

let imgPan = null
$('videoWrap').addEventListener('pointerdown', (e) => {
  if (imgZoom.scale <= 1.001 || !video.videoWidth) return
  imgPan = { sx: e.clientX, sy: e.clientY, ox: imgZoom.x, oy: imgZoom.y }
  video.style.cursor = 'grabbing'
})
window.addEventListener('pointermove', (e) => {
  if (!imgPan) return
  imgZoom.x = imgPan.ox + (e.clientX - imgPan.sx)
  imgZoom.y = imgPan.oy + (e.clientY - imgPan.sy)
  clampImgPan()
  applyImgZoom()
})
window.addEventListener('pointerup', () => { if (imgPan) { imgPan = null; applyImgZoom() } })
$('videoWrap').addEventListener('dblclick', () => { if (imgZoom.scale > 1.001) resetImgZoom() })

// ============================================================ Tier B — signets
// Repères temporels libres, distincts des scènes/plans : Ctrl+B pose/retire un
// signet au point de lecture ; Ctrl+, / Ctrl+. sautent au signet préc./suiv.
// Affichés en chevrons verts sur la barre de progression.
function toggleBookmark() {
  if (!project.bookmarks) project.bookmarks = []
  const now = Math.max(0, effectiveTime())
  const thr = Math.max(0.2, (seekDur() || 1) * 0.005)
  const i = project.bookmarks.findIndex((b) => Math.abs(b.time - now) <= thr)
  pushUndo()
  if (i >= 0) { project.bookmarks.splice(i, 1); toast(t('bookmarkRemoved')) }
  else { project.bookmarks.push({ id: uid(), time: now }); toast(t('bookmarkAdded')) }
  markDirty()
}
function gotoBookmark(dir) {
  const bm = [...(project.bookmarks || [])].sort((a, b) => a.time - b.time)
  if (!bm.length) { toast(t('bookmarkNone')); return }
  const now = effectiveTime()
  let target = dir > 0 ? bm.find((b) => b.time > now + 0.05) : [...bm].reverse().find((b) => b.time < now - 0.05)
  if (!target) target = dir > 0 ? bm[bm.length - 1] : bm[0]
  video.pause(); scrubTo(target.time)
}


// ============================================================ enregistrement voix (libre, par personnage)
// On enregistre librement au fil de la lecture. Chaque enregistrement est un clip
// rangé dans la « piste » du personnage ciblé : project.recordings = [{ id,
// characterId, file, startTime, dur, active }]. Les fichiers sont des sidecars
// (dossier « takes » via window.api.saveTake), jamais dans le JSON. Une piste perso
// s'entend en lecture comme une piste audio normale et peut être coupée
// (project.recMuted = [charId]). Chevauchement dans une même piste = prises
// alternatives (la plus récente reste active) ; enregistrements qui se suivent =
// ils coexistent. Les clips actifs (pistes non coupées) sont mixés à l'export.
const recorder = { stream: null, mr: null, chunks: [], active: false, charId: null, mime: 'audio/webm', ext: 'webm', ac: null, analyser: null, raf: 0, level: 0, recStartAt: 0 }
const takeAudios = new Map() // file -> HTMLAudioElement (cache lecture)
// durée effective d'un segment = durée du fichier moins les rognages (poignées de crop)
const recEffDur = (r) => Math.max(0, (r.dur || 0) - (r.trimStart || 0) - (r.trimEnd || 0))
const recOverlap = (a, b) => a.startTime < b.startTime + recEffDur(b) && b.startTime < a.startTime + recEffDur(a)
const REC_MAX_LANES = 4 // nombre max de pistes d'enregistrement empilées (takes)
// piste d'un segment : la 1re (de haut en bas) où il ne chevauche aucun segment déjà posé
function recAssignLane(clip) {
  const others = (project.recordings || []).filter((r) => r.characterId === clip.characterId && r.id !== clip.id)
  for (let ln = 0; ln < REC_MAX_LANES; ln++) {
    if (!others.some((r) => (r.lane || 0) === ln && recOverlap(r, clip))) return ln
  }
  return REC_MAX_LANES - 1
}
// nombre de pistes affichées pour un perso (au moins 1)
const recLaneCount = (charId) => 1 + (project.recordings || []).filter((r) => r.characterId === charId).reduce((m, r) => Math.max(m, r.lane || 0), 0)
// groupe de chevauchement d'un segment (les autres takes du même passage)
const recOverlapGroup = (clip) => (project.recordings || []).filter((r) => r.characterId === clip.characterId && r.id !== clip.id && recOverlap(r, clip))
// fichier joué/exporté : la version traitée par la chaîne voix quand elle est active
const recPlayFile = (r) => (project.voiceFxOn && r.fxFile) ? r.fxFile : r.file

// config capture (persistée côté main : audio-config.json)
const audioCfg = { api: 'system', device: null, deviceLabel: null, output: null, outputLabel: null, recOffsetMs: 0 }

function resetMic() {
  try { if (recorder.stream) recorder.stream.getTracks().forEach((t2) => t2.stop()) } catch {}
  try { if (recorder.ac) recorder.ac.close() } catch {}
  recorder.stream = null; recorder.ac = null; recorder.analyser = null; recorder.procStream = null
}

// crée un AudioContext calé sur la fréquence d'échantillonnage réelle de l'entrée.
// Sinon, si le périphérique (ex. MOTU à 44,1 kHz) diffère du taux par défaut du
// contexte (souvent 48 kHz), le MediaStreamAudioSourceNode n'est pas rééchantillonné
// par Chromium → la voix est transposée (pitch up/down).
function makeAcForStream(stream) {
  const AC = window.AudioContext || window.webkitAudioContext
  let rate = 0
  try { const s = stream.getAudioTracks()[0].getSettings(); rate = s && s.sampleRate } catch {}
  try { return rate ? new AC({ sampleRate: rate }) : new AC() } catch { return new AC() }
}

// micro mono (ex. « in 1L » d'une MOTU, présent sur le seul canal gauche) → dual-mono :
// on duplique le canal 0 sur L et R pour l'entendre au centre (deux oreilles)
function toDualMono(ac, node) {
  const splitter = ac.createChannelSplitter(2)
  const merger = ac.createChannelMerger(2)
  node.connect(splitter)
  splitter.connect(merger, 0, 0)
  splitter.connect(merger, 0, 1)
  return merger
}

async function ensureMic() {
  if (recorder.stream) return recorder.stream
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  try { recorder.stream = await openMic(base) } // périphérique mémorisé (par id, sinon par nom)
  catch (e) { toast(t('recMicDenied')); return null }
  try {
    recorder.ac = makeAcForStream(recorder.stream) // même taux que l'entrée (sinon pitch)
    const src = recorder.ac.createMediaStreamSource(recorder.stream)
    const mono = toDualMono(recorder.ac, src) // enregistre en dual-mono (L+R)
    recorder.analyser = recorder.ac.createAnalyser()
    recorder.analyser.fftSize = 512
    mono.connect(recorder.analyser)
    const dest = recorder.ac.createMediaStreamDestination()
    recorder.analyser.connect(dest) // flux traité (dual-mono) que MediaRecorder enregistre
    recorder.procStream = dest.stream
  } catch { recorder.procStream = null }
  return recorder.stream
}

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m
  }
  return 'audio/webm'
}

// personnage ciblé par l'enregistrement = personnage sélectionné (mécanisme unique)
function recTargetId() {
  const has = (id) => project.characters.some((c) => c.id === id)
  if (selectedCharId && has(selectedCharId)) return selectedCharId
  return project.characters[0]?.id || null
}
async function startRecording() {
  if (recorder.active) return
  const chId = recTargetId()
  if (!chId) { toast(t('recNeedChar')); return }
  recorder.charId = chId
  recorder.recStartAt = Math.max(0, effectiveTime()) // enregistrement libre : au playhead courant
  if ((audioCfg.api || 'system') === 'system') return startRecordingWeb()
  return startRecordingFfmpeg()
}

// --- capture navigateur (getUserMedia / WASAPI) ---
async function startRecordingWeb() {
  const stream = await ensureMic()
  if (!stream) return
  recorder.mode = 'web'
  recorder.mime = pickMime()
  recorder.ext = recorder.mime.includes('ogg') ? 'ogg' : 'webm'
  recorder.chunks = []
  const recStream = recorder.procStream || stream // dual-mono si dispo
  try { recorder.mr = new MediaRecorder(recStream, { mimeType: recorder.mime }) }
  catch { recorder.mr = new MediaRecorder(recStream) }
  recorder.mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) recorder.chunks.push(ev.data) }
  recorder.mr.onstop = () => finishRecordingWeb()
  // compensation de latence : on mesure le temps entre le vrai début de capture et le
  // vrai démarrage de la lecture (seek+play ne sont pas instantanés) — l'amorce sera rognée
  recorder.capAt = 0; recorder.playAt = 0
  recorder.mr.onstart = () => { recorder.capAt = performance.now() }
  video.addEventListener('playing', recOnPlaying, { once: true })
  recorder.active = true
  video.currentTime = recorder.recStartAt
  recorder.mr.start()
  video.play().catch(() => {})
  updateRecUI(); meterLoop()
}
function recOnPlaying() { recorder.playAt = performance.now() }
// latence d'entrée déclarée par le pipeline audio (périphérique → flux), si disponible
function inputLatencySec() {
  try { const s = recorder.stream?.getAudioTracks()[0].getSettings(); if (s && isFinite(s.latency) && s.latency > 0 && s.latency < 0.5) return s.latency } catch {}
  try { if (recorder.ac && isFinite(recorder.ac.baseLatency)) return recorder.ac.baseLatency } catch {}
  return 0
}
// compensation totale (s) appliquée à la nouvelle prise : amorce mesurée (capture
// démarrée avant la lecture) + latence d'entrée + réglage manuel des Paramètres
function recCompSec() {
  const gap = recorder.playAt && recorder.capAt ? Math.max(0, recorder.playAt - recorder.capAt) / 1000 : 0
  return gap + inputLatencySec() + (Number(audioCfg.recOffsetMs) || 0) / 1000
}

// --- capture DirectShow / ASIO (ffmpeg, process principal) ---
async function startRecordingFfmpeg() {
  const name = `rec_${recorder.charId}_${uid()}.wav`
  const r = await window.api.captureStart({ api: audioCfg.api, device: audioCfg.device, projectPath, name })
  if (!r || r.error) { toast(t(r && r.error === 'no-device' ? 'recNoDevice' : 'recCaptureFail')); return }
  recorder.mode = 'ffmpeg'
  recorder.captureName = name
  recorder.capAt = performance.now() // capture ffmpeg déjà lancée à cet instant
  recorder.playAt = 0
  video.addEventListener('playing', recOnPlaying, { once: true })
  recorder.active = true
  video.currentTime = recorder.recStartAt
  video.play().catch(() => {})
  updateRecUI()
}

function stopRecording() {
  if (!recorder.active) return
  video.removeEventListener('playing', recOnPlaying)
  if (recorder.mode === 'ffmpeg') return stopRecordingFfmpeg()
  if (!recorder.mr) return
  try { recorder.mr.stop() } catch {}
  video.pause(); recorder.active = false
}

async function stopRecordingFfmpeg() {
  video.pause(); recorder.active = false; recorder.mode = null; updateRecUI()
  const r = await window.api.captureStop()
  if (!r || r.error || !r.name) { toast(t('recCaptureFail')); return }
  await addRecording(recorder.charId, r.name, recorder.recStartAt, 0, recCompSec())
}

async function finishRecordingWeb() {
  cancelAnimationFrame(recorder.raf)
  recorder.level = 0
  recorder.active = false
  recorder.mode = null
  updateRecUI()
  const blob = new Blob(recorder.chunks, { type: recorder.mime })
  recorder.chunks = []
  if (!blob.size) return
  const buf = await blob.arrayBuffer()
  // durée fiable : le WebM de MediaRecorder n'a pas de durée dans son en-tête
  // (a.duration = Infinity) → on décode le blob pour obtenir la vraie durée
  let durHint = 0
  try { const ac = new (window.AudioContext || window.webkitAudioContext)(); const ab = await ac.decodeAudioData(buf.slice(0)); durHint = ab.duration; ac.close() } catch {}
  const name = `rec_${recorder.charId}_${uid()}.${recorder.ext}`
  const r = await window.api.saveTake(projectPath, name, buf)
  if (!r || r.error) { toast(t('recSaveFail')); return }
  await addRecording(recorder.charId, r.name, recorder.recStartAt, durHint, recCompSec())
}

// durée d'un fichier son : métadonnées rapides, sinon décodage complet (WebM sans en-tête)
async function probeClipDuration(url) {
  try { const d = await new Promise((res) => { const a = new Audio(); a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(0); a.src = url }); if (isFinite(d) && d > 0) return d } catch {}
  try { const resp = await fetch(url); const ab = await resp.arrayBuffer(); const ac = new (window.AudioContext || window.webkitAudioContext)(); const b = await ac.decodeAudioData(ab); ac.close(); return b.duration } catch {}
  return 0
}

// ajoute un clip enregistré à la piste du personnage (quel que soit le backend).
// comp (s) = compensation de latence : positif → on rogne l'amorce (la voix se cale
// plus tôt sur la timeline) ; négatif → le clip est décalé plus tard.
async function addRecording(charId, fileName, startTime, durHint, comp) {
  const url = await window.api.takeUrl(projectPath, fileName)
  let dur = (isFinite(durHint) && durHint > 0) ? durHint : 0
  if (!dur && url) dur = await probeClipDuration(url)
  pushUndo()
  project.recordings ||= []
  const clip = { id: uid(), characterId: charId, file: fileName, startTime, dur: dur || 0, trimStart: 0, trimEnd: 0, lane: 0, active: true }
  const c = Number(comp) || 0
  if (c > 0) clip.trimStart = Math.min(c, Math.max(0, (dur || 0) * 0.9))
  else if (c < 0) clip.startTime = Math.max(0, startTime - c)
  // chevauchement = autre take du même passage → le segment descend d'une piste et
  // devient la take retenue ; sans chevauchement il continue sur la piste 1
  clip.lane = recAssignLane(clip)
  for (const r of recOverlapGroup(clip)) r.active = false
  project.recordings.push(clip)
  selectedClipId = clip.id // sélectionne le segment qu'on vient d'enregistrer
  markDirty()
  if (activeTab === 'rec') renderRecTab()
  preloadTakeAudios()
  // chaîne voix active → la nouvelle prise est traitée dans la foulée
  if (project.voiceFxOn) fxProcessClip(clip).then((ok) => { if (ok) { markDirty(); preloadTakeAudios() } })
  toast(t('recSaved'))
}

// supprime tous les clips d'une piste perso (fichiers inclus)
async function deleteRecTrack(charId) {
  const clips = (project.recordings || []).filter((r) => r.characterId === charId)
  if (!clips.length) return
  pushUndo()
  for (const c of clips) {
    try { await window.api.deleteTake(projectPath, c.file) } catch {}; takeAudios.delete(c.file)
    if (c.fxFile) { try { await window.api.deleteTake(projectPath, c.fxFile) } catch {}; takeAudios.delete(c.fxFile) }
  }
  project.recordings = (project.recordings || []).filter((r) => r.characterId !== charId)
  markDirty()
  if (activeTab === 'rec') renderRecTab()
}
const isRecMuted = (id) => (project.recMuted || []).includes(id)
function toggleRecMute(id) {
  const was = isRecMuted(id)
  project.recMuted = (project.recMuted || []).filter((c) => c !== id)
  if (!was) project.recMuted.push(id)
  markDirty(); stopAllTakeAudio(); if (activeTab === 'rec') renderRecTab()
}

function meterLoop() {
  if (!recorder.active || !recorder.analyser) { updateRecMeter(0); return }
  const buf = new Uint8Array(recorder.analyser.fftSize)
  recorder.analyser.getByteTimeDomainData(buf)
  let peak = 0
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128) / 128; if (v > peak) peak = v }
  recorder.level = peak
  updateRecMeter(peak)
  recorder.raf = requestAnimationFrame(meterLoop)
}
let recVuPeakPct = 0, recVuPeakAt = 0
function updateRecMeter(level) {
  const pct = Math.min(100, level * 140)
  const bar = $('recMeterBar'); if (bar) bar.style.width = Math.round(pct) + '%'
  // vumètre vertical : le cache descend pour révéler l'échelle de couleur fixe
  const cover = $('recVuCover'); if (cover) cover.style.height = (100 - pct) + '%'
  // crête (peak hold ~1,2 s)
  const now = performance.now()
  if (pct >= recVuPeakPct || now - recVuPeakAt > 1200) { recVuPeakPct = pct; recVuPeakAt = now }
  const pk = $('recVuPeak')
  if (pk) { pk.style.bottom = recVuPeakPct + '%'; pk.style.opacity = recVuPeakPct > 1.5 ? 1 : 0 }
}
function updateRecUI() {
  const m = $('recMeter'); if (m) m.hidden = !recorder.active
  // rappel du périphérique d'entrée dans le drawer du vumètre
  const dev = $('recVuDev')
  if (dev) { const nm = audioCfg.deviceLabel || t('capDefault'); dev.textContent = nm; dev.title = nm }
  const big = $('recBigBtn')
  if (big) {
    big.classList.toggle('recording', recorder.active)
    big.title = t(recorder.active ? 'recStop' : 'recBtnLabel')
    const lbl = $('recBigLabel'); if (lbl) lbl.textContent = t(recorder.active ? 'recStopLabel' : 'recBtnLabel')
  }
}

// précharge les <audio> des prises retenues (lecture/monitoring sans latence) et
// purge celles qui ne sont plus référencées
async function preloadTakeAudios() {
  const wanted = new Set()
  let fixed = false
  for (const r of (project.recordings || [])) {
    const pf = recPlayFile(r) // version traitée par la chaîne voix si active
    wanted.add(pf)
    let url = null
    if (!takeAudios.has(pf)) { const u2 = await window.api.takeUrl(projectPath, pf); if (u2) takeAudios.set(pf, new Audio(u2)) }
    // auto-réparation : anciens enregistrements sans durée (WebM sans en-tête) → on la calcule
    if (!(r.dur > 0)) {
      url = url || await window.api.takeUrl(projectPath, r.file)
      if (url) { const d = await probeClipDuration(url); if (d > 0) { r.dur = d; fixed = true } }
    }
  }
  // anciens clips sans piste assignée (modèle pré-lanes) → assignation dans l'ordre
  for (const r of (project.recordings || [])) if (r.lane == null) { r.lane = recAssignLane(r); fixed = true }
  if (fixed) { // durées connues → (re)calcule chevauchement->takes (la plus récente active)
    for (const a of project.recordings) a.active = true
    for (let i = 0; i < project.recordings.length; i++) for (let k = i + 1; k < project.recordings.length; k++) { const a = project.recordings[i], b = project.recordings[k]; if (a.characterId === b.characterId && recOverlap(a, b)) a.active = false }
    markDirty(); if (activeTab === 'rec') renderRecTab()
  }
  for (const f of [...takeAudios.keys()]) if (!wanted.has(f)) takeAudios.delete(f)
}

function stopAllTakeAudio() { for (const a of takeAudios.values()) if (!a.paused) a.pause() }

// lecture des enregistrements : pendant la lecture, joue les clips actifs des pistes
// perso non coupées, calés sur leur position timeline (comme une piste audio normale).
function syncTakesMonitor() {
  if (recorder.active || video.paused) { stopAllTakeAudio(); return }
  const now = effectiveTime()
  const muted = project.recMuted || []
  for (const r of (project.recordings || [])) {
    const a = takeAudios.get(recPlayFile(r)); if (!a) continue
    const eff = recEffDur(r)
    const playable = r.active && eff > 0 && !muted.includes(r.characterId) && now >= r.startTime && now < r.startTime + eff
    if (playable) {
      const target = now - r.startTime + (r.trimStart || 0) // fenêtre rognée → position dans le fichier
      if (a.paused) { a.currentTime = target; a.play().catch(() => {}) }
      else if (Math.abs(a.currentTime - target) > 0.3) a.currentTime = target
    } else if (!a.paused) a.pause()
  }
}

// ---------- onglet Enregistrement ----------
function toggleRecord() {
  if (recorder.active) { stopRecording(); return }
  startRecording()
}

// ---- bande rythmo en rendu final (comme la preview plein écran) dans l'onglet Enregistrement
const recBandCanvas = $('recBand')
const recBandCtx = recBandCanvas.getContext('2d')
let rbw = 0, rbh = 0
let recWinSec = 3 // secondes visibles (réglable à la molette Ctrl, comme la bande rythmo)
const REC_SEC_MIN = 1.2, REC_SEC_MAX = 12
// Ctrl+molette = zoom/dézoom (partagé entre la bande et l'affichage des prises)
function recWheelZoom(e) {
  if (!e.ctrlKey) return false
  e.preventDefault()
  recWinSec = clamp(recWinSec * (e.deltaY < 0 ? 1 / 1.12 : 1.12), REC_SEC_MIN, REC_SEC_MAX)
  return true
}
function resizeRecBand() {
  const wrap = $('recBandWrap'); if (!wrap) return
  const r = wrap.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  rbw = r.width; rbh = r.height
  const pw = Math.round(rbw * dpr), ph = Math.round(rbh * dpr)
  if (recBandCanvas.width !== pw || recBandCanvas.height !== ph) {
    recBandCanvas.width = pw; recBandCanvas.height = ph
    recBandCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}
new ResizeObserver(() => { if (activeTab === 'rec') resizeRecBand() }).observe($('recBandWrap'))
function drawRecBand() {
  if (!rbw) { resizeRecBand(); if (!rbw) return }
  // piste unique : toutes les répliques du perso sélectionné écrasées au bon timing,
  // indépendamment de leurs pistes 1-4 de l'éditeur
  const chId = recTargetId()
  const squashed = project.lines.filter((l) => l.characterId === chId).map((l) => ({ ...l, track: 0 }))
  renderBand(recBandCtx, effectiveTime(), rbw, rbh, rbw / recWinSec, { ruler: false, wave: false, handles: false, theme: bandPal(), lines: squashed, trackList: [0] })
}
// glisser = déplacer la timeline, comme la bande rythmo (attrape-et-déplace, relatif)
let recBandDrag = null
recBandCanvas.addEventListener('pointerdown', (e) => {
  recBandCanvas.setPointerCapture(e.pointerId); video.pause()
  recBandDrag = { x0: e.clientX, t0: effectiveTime(), moved: false }
  recBandCanvas.style.cursor = 'grabbing'
})
recBandCanvas.addEventListener('pointermove', (e) => {
  if (!recBandDrag) return
  const dx = e.clientX - recBandDrag.x0
  if (Math.abs(dx) > 3) recBandDrag.moved = true
  if (recBandDrag.moved) { scrubTo(recBandDrag.t0 - dx / (rbw / recWinSec)); playScrubGrain(scrub.time) }
})
const recBandEnd = () => { recBandDrag = null; recBandCanvas.style.cursor = 'grab'; if (!scrub.busy && scrub.pending == null) scrub.time = null }
recBandCanvas.addEventListener('pointerup', recBandEnd)
recBandCanvas.addEventListener('pointercancel', recBandEnd)
recBandCanvas.addEventListener('wheel', (e) => {
  if (recWheelZoom(e)) return
  e.preventDefault(); video.pause()
  scrubTo(effectiveTime() + (e.deltaY || e.deltaX) / (rbw / recWinSec) * 0.8); playScrubGrain(scrub.time)
}, { passive: false })

// ---- forme d'onde des prises : décodage + peaks, en cache par fichier ----
const clipWaves = new Map() // file -> {peaks,perSec,duration} | 'pending' | null
async function ensureClipWave(file) {
  if (clipWaves.has(file)) return
  clipWaves.set(file, 'pending')
  try {
    const url = await window.api.takeUrl(projectPath, file)
    const resp = await fetch(url); const ab = await resp.arrayBuffer()
    const ac = new AudioContext({ sampleRate: 16000 })
    const audio = await ac.decodeAudioData(ab); ac.close()
    const PER = 80, n = Math.max(1, Math.ceil(audio.duration * PER))
    const peaks = new Float32Array(n), d = audio.getChannelData(0), spb = audio.sampleRate / PER
    for (let i = 0; i < d.length; i++) { const b = Math.min(n - 1, (i / spb) | 0); const v = Math.abs(d[i]); if (v > peaks[b]) peaks[b] = v }
    let max = 0; for (let i = 0; i < n; i++) if (peaks[i] > max) max = peaks[i]; if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max
    clipWaves.set(file, { peaks, perSec: PER, duration: audio.duration })
  } catch { clipWaves.set(file, null) }
}

// ---- affichage des prises (blocs sélectionnables/glissables + waveform) ----
let selectedClipId = null
const recClipsCanvas = $('recClips')
const recClipsCtx = recClipsCanvas.getContext('2d')
let rcw = 0, rch = 0
function resizeRecClips() {
  const r = recClipsCanvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  rcw = r.width; rch = r.height
  const pw = Math.round(rcw * dpr), ph = Math.round(rch * dpr)
  if (recClipsCanvas.width !== pw || recClipsCanvas.height !== ph) {
    recClipsCanvas.width = pw; recClipsCanvas.height = ph
    recClipsCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}
new ResizeObserver(() => { if (activeTab === 'rec') resizeRecClips() }).observe(recClipsCanvas)
const recClipsPps = () => rcw / recWinSec
const recClipXAt = (t) => rcw * READ_RATIO + (t - effectiveTime()) * recClipsPps()
// hauteur FIXE d'une piste de takes ; le canvas prend la hauteur du contenu et le
// conteneur (#recClipsWrap) scrolle verticalement pour parcourir les takes
const REC_LANE_H = 44
function syncRecClipsHeight() {
  // le canvas remplit AU MOINS tout l'espace restant : la zone vide sous les pistes
  // fait partie de la timeline (la barre de lecture la traverse, les pistes futures
  // s'y ajouteront) ; au-delà, il grandit et le conteneur scrolle
  const wrap = $('recClipsWrap')
  const want = Math.max(recLaneCount(recTargetId()) * REC_LANE_H, wrap ? wrap.clientHeight : 0)
  if (recClipsCanvas._lanesH !== want) { recClipsCanvas._lanesH = want; recClipsCanvas.style.height = want + 'px' }
}
// mini haut-parleur dessiné sur un segment multi-takes (retenue = ondes, sinon barré)
function drawClipSpk(c, x, y, s, col, on) {
  c.save(); c.translate(x, y); c.scale(s / 16, s / 16)
  c.fillStyle = col
  c.beginPath(); c.moveTo(2, 6); c.lineTo(5, 6); c.lineTo(9, 2.5); c.lineTo(9, 13.5); c.lineTo(5, 10); c.lineTo(2, 10); c.closePath(); c.fill()
  c.strokeStyle = col; c.lineWidth = 1.6; c.beginPath()
  if (on) { c.arc(9.5, 8, 4.2, -1.05, 1.05) } else { c.moveTo(11.5, 6); c.lineTo(15, 9.8); c.moveTo(15, 6); c.lineTo(11.5, 9.8) }
  c.stroke(); c.restore()
}
function drawRecClips() {
  if (!rcw) { resizeRecClips(); if (!rcw) return }
  syncRecClipsHeight()
  const pal = bandPal()
  recClipsCtx.fillStyle = pal.rulerBg || pal.bg; recClipsCtx.fillRect(0, 0, rcw, rch)
  const chId = recTargetId()
  const clips = (project.recordings || []).filter((r) => r.characterId === chId)
  const lanes = recLaneCount(chId)
  const laneH = REC_LANE_H // hauteur fixe : la zone vide sous les pistes reste de la timeline
  const isMuted = isRecMuted(chId)
  const pps = recClipsPps()
  // fonds de pistes alternés + séparateurs
  for (let ln = 0; ln <= lanes; ln++) { // <= : trait de clôture sous la dernière piste
    if (ln < lanes && ln % 2 === 1) { recClipsCtx.fillStyle = pal.lane; recClipsCtx.fillRect(0, ln * laneH, rcw, laneH) }
    recClipsCtx.strokeStyle = pal.grid; recClipsCtx.beginPath(); recClipsCtx.moveTo(0, ln * laneH + 0.5); recClipsCtx.lineTo(rcw, ln * laneH + 0.5); recClipsCtx.stroke()
  }
  const col = getChar(chId)?.color || '#888'
  for (const r of clips) {
    const eff = recEffDur(r)
    const x0 = recClipXAt(r.startTime), x1 = recClipXAt(r.startTime + eff)
    if (x1 < -20 || x0 > rcw + 20) continue
    const laneY = (r.lane || 0) * laneH
    const y = laneY + 3, h = laneH - 6
    const active = r.active && !isMuted
    const selected = r.id === selectedClipId
    const xa = Math.max(-2, x0), wpx = Math.max(3, Math.min(rcw + 2, x1) - xa)
    recClipsCtx.globalAlpha = active ? 0.9 : 0.45
    recClipsCtx.fillStyle = col + '2e'
    recClipsCtx.beginPath(); recClipsCtx.roundRect(xa, y, wpx, h, 4); recClipsCtx.fill()
    // waveform du fichier, décalée du rognage de début
    const wv = clipWaves.get(r.file)
    if (wv && wv.peaks) {
      const mid = y + h / 2, amp = h / 2 - 3
      const va = Math.max(0, x0), vb = Math.min(rcw, x1)
      recClipsCtx.fillStyle = col; recClipsCtx.globalAlpha = active ? 0.85 : 0.4
      recClipsCtx.beginPath(); recClipsCtx.moveTo(va, mid)
      for (let x = va; x <= vb; x++) { const tt = (x - x0) / pps + (r.trimStart || 0); let v = 0; if (tt >= 0 && tt < wv.duration) { const b = (tt * wv.perSec) | 0; if (b < wv.peaks.length) v = wv.peaks[b] } recClipsCtx.lineTo(x, mid - v * amp) }
      for (let x = vb; x >= va; x--) { const tt = (x - x0) / pps + (r.trimStart || 0); let v = 0; if (tt >= 0 && tt < wv.duration) { const b = (tt * wv.perSec) | 0; if (b < wv.peaks.length) v = wv.peaks[b] } recClipsCtx.lineTo(x, mid + v * amp) }
      recClipsCtx.closePath(); recClipsCtx.fill()
    } else if (wv === undefined) { ensureClipWave(r.file) }
    // bordure (sélection = accent épais) + poignées de crop quand sélectionné
    recClipsCtx.globalAlpha = 1
    recClipsCtx.strokeStyle = selected ? pal.handleAccent : col + 'aa'
    recClipsCtx.lineWidth = selected ? 2 : 1
    recClipsCtx.beginPath(); recClipsCtx.roundRect(xa + 0.5, y + 0.5, wpx - 1, h - 1, 4); recClipsCtx.stroke()
    recClipsCtx.lineWidth = 1
    if (selected) {
      recClipsCtx.fillStyle = pal.handleAccent
      recClipsCtx.fillRect(x0 - 2, y + 2, 4, h - 4)
      recClipsCtx.fillRect(x1 - 2, y + 2, 4, h - 4)
    }
    // label « Prise N » (comme le nom sur les phrases) + bouton haut-parleur accolé
    // (haut-parleur seulement si le segment a plusieurs takes)
    const multi = recOverlapGroup(r).length > 0
    const lx = Math.max(2, x0) + 3
    if (multi) {
      recClipsCtx.globalAlpha = 0.92
      recClipsCtx.fillStyle = pal.bg
      recClipsCtx.beginPath(); recClipsCtx.roundRect(lx, y + 3, 20, 20, 4); recClipsCtx.fill()
      recClipsCtx.globalAlpha = 1
      drawClipSpk(recClipsCtx, lx + 2, y + 5, 16, r.active ? pal.handleAccent : pal.tickText, r.active)
    }
    recClipsCtx.globalAlpha = 1
    recClipsCtx.fillStyle = pal.tickText
    recClipsCtx.font = '11px "Segoe UI", sans-serif'; recClipsCtx.textBaseline = 'middle'; recClipsCtx.textAlign = 'left'
    recClipsCtx.fillText(t('recTakeN', (r.lane || 0) + 1), lx + (multi ? 25 : 4), y + 13)
  }
  const px = rcw * READ_RATIO
  recClipsCtx.strokeStyle = pal.playhead; recClipsCtx.lineWidth = 1.5
  recClipsCtx.beginPath(); recClipsCtx.moveTo(px + 0.5, 0); recClipsCtx.lineTo(px + 0.5, rch); recClipsCtx.stroke(); recClipsCtx.lineWidth = 1
}
// hit-test : segment + zone (haut-parleur, poignée gauche/droite, corps)
function recClipHit(px, py) {
  const chId = recTargetId()
  const lanes = recLaneCount(chId)
  const laneH = REC_LANE_H
  if (py >= lanes * laneH) return null // zone vide sous les pistes
  const ln = clamp(Math.floor(py / laneH), 0, lanes - 1)
  for (const r of (project.recordings || [])) {
    if (r.characterId !== chId || (r.lane || 0) !== ln) continue
    const x0 = recClipXAt(r.startTime), x1 = recClipXAt(r.startTime + recEffDur(r))
    if (px < x0 - 5 || px > x1 + 5) continue
    const y = ln * laneH + 3
    if (recOverlapGroup(r).length && px >= Math.max(2, x0) + 3 && px <= Math.max(2, x0) + 23 && py >= y + 3 && py <= y + 23) return { clip: r, zone: 'spk' }
    if (Math.abs(px - x0) <= 5) return { clip: r, zone: 'l' }
    if (Math.abs(px - x1) <= 5) return { clip: r, zone: 'r' }
    return { clip: r, zone: 'move' }
  }
  return null
}
// dans chaque groupe de chevauchement : exactement une take retenue (active)
function recNormalizeActive(charId) {
  const clips = (project.recordings || []).filter((r) => r.characterId === charId)
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i]; if (!c.active) continue
    for (let k = 0; k < i; k++) { const o = clips[k]; if (o.active && recOverlap(o, c)) o.active = false }
  }
  for (const c of clips) {
    const grp = clips.filter((o) => o !== c && recOverlap(o, c))
    if (!grp.length) c.active = true
    else if (!c.active && !grp.some((o) => o.active)) c.active = true
  }
}
// sélectionne un segment (sélection visuelle seule — la take retenue se règle au haut-parleur)
function selectClip(id) {
  selectedClipId = id
  const clip = (project.recordings || []).find((r) => r.id === id)
  if (clip && clip.characterId !== selectedCharId) { selectedCharId = clip.characterId; renderChars() }
}
// clic haut-parleur : ce segment devient la take retenue de son groupe
function retainClip(clip) {
  pushUndo()
  for (const r of recOverlapGroup(clip)) r.active = false
  clip.active = true
  // chaîne voix active → la take nouvellement retenue est traitée si besoin
  if (project.voiceFxOn && !clip.fxFile) fxProcessClip(clip).then((ok) => { if (ok) { markDirty(); preloadTakeAudios() } })
  markDirty()
}
let clipDrag = null
recClipsCanvas.addEventListener('pointerdown', (e) => {
  const rct = recClipsCanvas.getBoundingClientRect()
  const hit = recClipHit(e.clientX - rct.left, e.clientY - rct.top)
  if (!hit) { selectedClipId = null; return }
  if (hit.zone === 'spk') { selectClip(hit.clip.id); retainClip(hit.clip); return }
  recClipsCanvas.setPointerCapture(e.pointerId)
  selectClip(hit.clip.id)
  clipDrag = { clip: hit.clip, zone: hit.zone, x0: e.clientX, start0: hit.clip.startTime, trimS0: hit.clip.trimStart || 0, trimE0: hit.clip.trimEnd || 0, moved: false, pushed: false }
})
recClipsCanvas.addEventListener('pointermove', (e) => {
  const rct = recClipsCanvas.getBoundingClientRect()
  if (!clipDrag) {
    const hit = recClipHit(e.clientX - rct.left, e.clientY - rct.top)
    recClipsCanvas.style.cursor = !hit ? 'default' : hit.zone === 'move' ? 'grab' : hit.zone === 'spk' ? 'pointer' : 'col-resize'
    return
  }
  const dt = (e.clientX - clipDrag.x0) / recClipsPps()
  if (Math.abs(e.clientX - clipDrag.x0) > 3) clipDrag.moved = true
  if (!clipDrag.moved) return
  if (!clipDrag.pushed) { pushUndo(); clipDrag.pushed = true }
  const c = clipDrag.clip
  if (clipDrag.zone === 'move') {
    c.startTime = Math.max(0, clipDrag.start0 + dt)
  } else if (clipDrag.zone === 'l') {
    // poignée gauche : rogne le début (l'audio restant reste calé sur la timeline)
    const ts = clamp(clipDrag.trimS0 + dt, 0, (c.dur || 0) - (c.trimEnd || 0) - 0.1)
    c.startTime = Math.max(0, clipDrag.start0 + (ts - clipDrag.trimS0))
    c.trimStart = ts
  } else if (clipDrag.zone === 'r') {
    c.trimEnd = clamp(clipDrag.trimE0 - dt, 0, (c.dur || 0) - (c.trimStart || 0) - 0.1)
  }
  markDirty()
})
function clipDragEnd() {
  if (clipDrag && clipDrag.moved) {
    const clip = clipDrag.clip
    clip.lane = recAssignLane(clip) // remonte si plus de chevauchement, descend sinon
    recNormalizeActive(clip.characterId)
    renderRecCharList()
  }
  clipDrag = null; recClipsCanvas.style.cursor = 'default'
}
recClipsCanvas.addEventListener('pointerup', clipDragEnd)
recClipsCanvas.addEventListener('pointercancel', clipDragEnd)
recClipsCanvas.addEventListener('wheel', (e) => {
  recWheelZoom(e) // Ctrl+molette = zoom ; molette simple = scroll vertical natif des takes
}, { passive: false })

function renderRecTab() {
  const noChars = !project.videoPath || !project.characters.length
  $('recEmpty').classList.toggle('hidden', !noChars)
  $('recMain').classList.toggle('hidden', noChars)
  if (noChars) return
  resizeRecBand()
  resizeRecClips()
  updateRecCharBadge()
  renderRecCharList()
  updateRecUI()
}

// badge du personnage ciblé par l'enregistrement (comme le badge « + Réplique » du menu
// rythmo) : nom rempli de la couleur du perso, outline porté par le groupe
function updateRecCharBadge() {
  const c = getChar(recTargetId())
  const badge = $('recCharBadge')
  if (badge) {
    badge.textContent = c ? c.name : '—'
    badge.style.background = c ? c.color : 'transparent'
    badge.style.color = c ? textOn(c.color) : 'var(--dim)'
    badge.title = c ? c.name : ''
  }
  const grp = $('recSegGroup'); if (grp) grp.style.borderColor = c ? c.color : ''
}

async function deleteClip(id) {
  const idx = (project.recordings || []).findIndex((r) => r.id === id); if (idx < 0) return
  const cl = project.recordings[idx]
  pushUndo()
  project.recordings.splice(idx, 1)
  try { await window.api.deleteTake(projectPath, cl.file) } catch {}
  if (cl.fxFile) { try { await window.api.deleteTake(projectPath, cl.fxFile) } catch {}; takeAudios.delete(cl.fxFile) }
  takeAudios.delete(cl.file); clipWaves.delete(cl.file)
  if (selectedClipId === id) selectedClipId = null
  // réactive la dernière prise restante qui chevauchait, le cas échéant (latest wins)
  markDirty(); renderRecTab()
}

// ============================================================ chaîne voix (auto-mix)
// EQ + compression + niveau calculés automatiquement d'après l'ANALYSE de chaque prise
// (approche type Auphonic AutoEQ/Leveler) : énergie par bande → filtres correctifs,
// facteur de crête → compression, puis normalisation vers une cible ≈ -16 dBFS RMS
// (podcast/US, approx. LUFS) équilibrée avec le niveau moyen de la piste vidéo.
// Le résultat est PRÉCALCULÉ en WAV sidecar (fx_*.wav) : lecture et export l'utilisent.
let fxBusy = false
const dbOf = (x) => 10 * Math.log10(x + 1e-12)

// biquad RBJ minimal (analyse par bande, O(n), hors WebAudio)
function biquadRms(data, sr, type, fc, Q) {
  const w0 = 2 * Math.PI * fc / sr, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * Q)
  let b0, b1, b2
  if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al }
  else if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0 }
  else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0 } // highpass
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al
  b0 /= a0; b1 /= a0; b2 /= a0
  const na1 = a1 / a0, na2 = a2 / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, sq = 0
  for (let i = 0; i < data.length; i++) {
    const x = data[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - na1 * y1 - na2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    sq += y * y
  }
  return dbOf(sq / Math.max(1, data.length))
}

// analyse d'une prise : niveau moyen (fenêtres voisées), crête, énergie par bande →
// réglages de la chaîne (EQ correctif, compression, seuil)
function analyzeVoice(buf, light) {
  const d = buf.getChannelData(0), sr = buf.sampleRate
  const win = Math.max(1, Math.round(sr * 0.05))
  const rmsW = []
  for (let i = 0; i + win <= d.length; i += win) {
    let sq = 0
    for (let k = i; k < i + win; k++) sq += d[k] * d[k]
    rmsW.push(dbOf(sq / win))
  }
  const maxW = rmsW.length ? Math.max(...rmsW) : -90
  const voiced = rmsW.filter((v) => v > maxW - 30)
  const rmsDb = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : maxW
  let pk = 1e-9
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a }
  const peakDb = 20 * Math.log10(pk)
  if (light) return { rmsDb, peakDb }
  const full = rmsW.length ? rmsW.reduce((a, b) => a + b, 0) / rmsW.length : -90
  // énergie relative par bande vs référence « voix neutre » (empirique)
  const lowRel = biquadRms(d, sr, 'lowpass', 90, 0.71) - full   // gronde/pop
  const mudRel = biquadRms(d, sr, 'bandpass', 300, 1) - full    // boue 200-500 Hz
  const presRel = biquadRms(d, sr, 'bandpass', 3500, 0.9) - full // présence/intelligibilité
  const sibRel = biquadRms(d, sr, 'bandpass', 7000, 1.5) - full  // sibilance
  const crest = peakDb - rmsDb
  return {
    rmsDb, peakDb,
    hpFc: lowRel > -6 ? 110 : 85,                       // coupe-bas plus haut si ça gronde
    eqMud: clamp(-(mudRel + 6) * 0.9, -6, 0),           // cut boue si excès
    eqPres: clamp((-10 - presRel) * 0.7, 0, 4),         // boost présence si voix sourde
    eqSib: clamp(-(sibRel + 14) * 1.0, -8, 0),          // dé-esseur statique si sibilance
    ratio: crest >= 18 ? 4 : crest >= 12 ? 3 : 2.2,     // compression selon la dynamique
    thresh: clamp(rmsDb + 4, -45, -8),
  }
}

// cible de niveau : équilibrée avec la piste audio de la vidéo, sinon ≈ -16 (podcast/US)
const fxTargetDb = () => (videoRmsDb != null && isFinite(videoRmsDb)) ? clamp(videoRmsDb + 4, -22, -13) : -16

// rendu offline de la chaîne : HP → EQ boue → présence → dé-ess → comp → (pass 2) gain vers la cible → limiteur
async function renderVoiceChain(buf, A, targetDb) {
  const off = new OfflineAudioContext(buf.numberOfChannels, buf.length, buf.sampleRate)
  const src = off.createBufferSource(); src.buffer = buf
  const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = A.hpFc; hp.Q.value = 0.71
  const mud = off.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1; mud.gain.value = A.eqMud
  const pres = off.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3500; pres.Q.value = 0.9; pres.gain.value = A.eqPres
  const sib = off.createBiquadFilter(); sib.type = 'peaking'; sib.frequency.value = 7000; sib.Q.value = 2; sib.gain.value = A.eqSib
  const comp = off.createDynamicsCompressor(); comp.threshold.value = A.thresh; comp.ratio.value = A.ratio; comp.attack.value = 0.004; comp.release.value = 0.18; comp.knee.value = 8
  src.connect(hp); hp.connect(mud); mud.connect(pres); pres.connect(sib); sib.connect(comp); comp.connect(off.destination)
  src.start()
  const mid = await off.startRendering()
  const A2 = analyzeVoice(mid, true)
  const g = Math.pow(10, clamp(targetDb - A2.rmsDb, -24, 24) / 20)
  const off2 = new OfflineAudioContext(mid.numberOfChannels, mid.length, mid.sampleRate)
  const s2 = off2.createBufferSource(); s2.buffer = mid
  const gn = off2.createGain(); gn.gain.value = g
  const lim = off2.createDynamicsCompressor(); lim.threshold.value = -2; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1; lim.knee.value = 1
  s2.connect(gn); gn.connect(lim); lim.connect(off2.destination); s2.start()
  return off2.startRendering()
}

// AudioBuffer → WAV PCM 16 bits (sidecar précalculé)
function encodeWav16(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length
  const bytes = 44 + n * ch * 2
  const ab = new ArrayBuffer(bytes); const v = new DataView(ab)
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  ws(0, 'RIFF'); v.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true)
  ws(36, 'data'); v.setUint32(40, n * ch * 2, true)
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c))
  let o = 44
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2 }
  return ab
}

// analyse + traite une prise → écrit le sidecar fx_*.wav et le référence sur le clip
async function fxProcessClip(r) {
  try {
    const url = await window.api.takeUrl(projectPath, r.file); if (!url) return false
    const resp = await fetch(url); const ab = await resp.arrayBuffer()
    const dc = new (window.AudioContext || window.webkitAudioContext)()
    const buf = await dc.decodeAudioData(ab); dc.close()
    const out = await renderVoiceChain(buf, analyzeVoice(buf), fxTargetDb())
    const name = 'fx_' + r.file.replace(/\.[^.]+$/, '') + '.wav'
    const res = await window.api.saveTake(projectPath, name, encodeWav16(out))
    if (!res || res.error) return false
    r.fxFile = res.name
    return true
  } catch { return false }
}

// ============================================================ export des prises (ZIP)
// Même UX que l'export vidéo : options, destination, barre de progression.
// Mix complet par personnage (prises actives, timeline respectée) + option prises
// détachées horodatées — le tout dans un ZIP, source brute ou traitée (FX).
const tkModal = $('takesModal')
let tkBusy = false
function openTakesExport() {
  if (!(project.recordings || []).length) { toast(t('tkNone')); return }
  tkModal.classList.remove('hidden')
  $('tkBar').style.width = '0%'
  $('tkStatus').textContent = ''
  $('tkSource').value = project.voiceFxOn ? 'fx' : 'raw'
}
const tkSuggestedName = () => (projectPath ? baseName(projectPath).replace(/\.[^.]+$/, '') : baseName(project.videoPath || 'prises').replace(/\.[^.]+$/, '')) + '-prises.zip'
$('tkBrowse').addEventListener('click', async () => {
  const p = await window.api.takesExportPick(tkSuggestedName())
  if (p) $('tkPath').value = p
})
$('tkClose').addEventListener('click', () => { if (!tkBusy) tkModal.classList.add('hidden') })
window.api.onTakesProgress((p) => {
  if (!p || tkModal.classList.contains('hidden')) return
  $('tkBar').style.width = `${Math.round(((p.i || 0) / Math.max(1, p.n || 1)) * 100)}%`
  $('tkStatus').textContent = p.label === 'zip' ? t('tkPhaseZip') : t('tkPhaseMix', p.label)
})
async function runTakesExport() {
  if (tkBusy) return
  let outPath = $('tkPath').value.trim()
  if (!outPath) { const p = await window.api.takesExportPick(tkSuggestedName()); if (!p) return; outPath = p; $('tkPath').value = p }
  if (!/\.zip$/i.test(outPath)) { outPath += '.zip'; $('tkPath').value = outPath }
  const useFx = $('tkSource').value === 'fx'
  const pick = (r) => (useFx && r.fxFile) ? r.fxFile : r.file
  const clipInfo = (r) => ({ name: pick(r), trimStart: r.trimStart || 0, effDur: recEffDur(r), offset: r.startTime, takeN: (r.lane || 0) + 1 })
  const chars = project.characters
    .map((c) => {
      const all = (project.recordings || []).filter((r) => r.characterId === c.id && recEffDur(r) > 0)
      return { name: c.name, active: all.filter((r) => r.active).map(clipInfo), all: all.map(clipInfo) }
    })
    .filter((c) => c.all.length)
  tkBusy = true
  $('tkGo').disabled = true
  $('tkStatus').textContent = t('tkPhaseMix', '…')
  const r = await window.api.exportTakes({
    outPath, projectPath, includeDetached: $('tkDetached').checked, chars,
    videoDur: (isFinite(video.duration) && video.duration > 0) ? video.duration
      : Math.max(1, ...(project.recordings || []).map((k) => k.startTime + recEffDur(k))),
  })
  tkBusy = false
  $('tkGo').disabled = false
  if (r && r.ok) {
    $('tkBar').style.width = '100%'
    $('tkStatus').textContent = t('tkDone', r.count)
    toast(t('tkDone', r.count))
  } else {
    $('tkStatus').textContent = t('tkFail') + (r && r.error ? ' — ' + String(r.error).slice(0, 120) : '')
  }
}
$('tkGo').addEventListener('click', runTakesExport)

// bouton « chaîne voix » : traite toutes les takes actives qui ne le sont pas encore
async function toggleVoiceFx() {
  if (fxBusy) return
  if (project.voiceFxOn) {
    project.voiceFxOn = false
    markDirty(); stopAllTakeAudio(); preloadTakeAudios(); renderRecCharList()
    return
  }
  fxBusy = true; renderRecCharList()
  let n = 0
  for (const r of (project.recordings || [])) {
    if (!r.active || r.fxFile) continue
    if (await fxProcessClip(r)) n++
  }
  project.voiceFxOn = true
  fxBusy = false
  markDirty(); stopAllTakeAudio(); await preloadTakeAudios(); renderRecCharList()
  toast(t('recFxDone', n))
}

// encart de gauche : uniquement le personnage sélectionné (la sélection se fait via le
// drawer Personnages ou les touches 1-9) + mute de sa piste d'enregistrement
function renderRecCharList() {
  const list = $('recCharList'); if (!list) return
  list.innerHTML = ''
  const c = getChar(recTargetId())
  if (!c) return
  const clips = (project.recordings || []).filter((r) => r.characterId === c.id)
  const row = document.createElement('div')
  row.className = 'rec-ch target' + (isRecMuted(c.id) ? ' muted' : '')
  const head = document.createElement('div'); head.className = 'rec-ch-head'
  const dot = document.createElement('span'); dot.className = 'rec-dot-c'; dot.style.background = c.color || '#888'
  const nm = document.createElement('span'); nm.className = 'rec-ch-name'; nm.textContent = c.name
  // bouton FX : chaîne d'effets auto (EQ/comp/niveau) sur les takes retenues —
  // les nouveaux enregistrements sont traités à la volée tant que c'est actif
  const fx = document.createElement('button')
  fx.className = 'rec-fxbtn' + (project.voiceFxOn ? ' on' : '')
  fx.textContent = 'FX'
  fx.disabled = fxBusy
  fx.title = fxBusy ? t('recFxBusy') : t('recFxHint')
  fx.addEventListener('click', (e) => { e.stopPropagation(); toggleVoiceFx() })
  const mute = document.createElement('button'); mute.className = 'trk-spk' + (isRecMuted(c.id) ? '' : ' on'); mute.innerHTML = isRecMuted(c.id) ? SPK_OFF_SVG : SPK_ON_SVG
  mute.title = t('recMuteTrack'); mute.addEventListener('click', (e) => { e.stopPropagation(); toggleRecMute(c.id) })
  head.append(dot, nm, fx, mute)
  row.appendChild(head)
  const meta = document.createElement('div'); meta.className = 'rec-ch-meta'
  meta.textContent = clips.length ? t('recTakes', clips.length) : t('recNoTakes')
  row.appendChild(meta)
  list.appendChild(row)
}

$('recBigBtn').addEventListener('click', toggleRecord)


// ============================================================ transcription automatique
// Génère le texte depuis l'audio via whisper.cpp (moteur fourni par l'utilisateur,
// modèle téléchargé à la demande — rien de bundlé). Le résultat SRT est importé par
// importSubsText (circuit éprouvé). Dégrade proprement si le moteur est absent.
const trModal = $('transcribeModal')
let trBusy = false

// prêt à transcrire = moteur configuré ET au moins un modèle installé (tout se
// configure dans les Paramètres ; la modale ne fait qu'utiliser ce qui est installé)
async function transcribeReadiness() {
  let engine = false
  try { engine = (await window.api.whisperEngineStatus()).installed } catch {}
  let models = []
  try { models = (await window.api.whisperListModels()).filter((m) => m.present) } catch {}
  return { engine, models }
}

async function openTranscribeDialog() {
  if (!project.videoPath) { toast(t('trNeedVideo')); return }
  trModal.classList.remove('hidden')
  $('trBar').style.width = '0%'
  $('trStatus').textContent = ''
  const { engine, models } = await transcribeReadiness()
  if (models.length && !models.some((m) => m.model === activeWhisper())) setActiveWhisper(models[0].model)
  const ready = engine && models.length > 0
  $('trNotReady').classList.toggle('hidden', ready)
  $('trReady').classList.toggle('hidden', !ready)
  $('trGo').classList.toggle('hidden', !ready)
  if (!ready) { $('trNotReadyMsg').textContent = !engine ? t('trNeedEngine') : t('trNeedModel'); return }
  // piste source
  trTracks = audioSourceOptions()
  const tsel = $('trInTrack'); tsel.innerHTML = ''
  trTracks.forEach((o, i) => { const op = document.createElement('option'); op.value = String(i); op.textContent = o.label; tsel.appendChild(op) })
  // dropdown modèle (installés) — défaut = modèle actif
  const msel = $('trModel'); msel.innerHTML = ''
  for (const m of models) { const o = document.createElement('option'); o.value = m.model; o.textContent = `${m.model} (${fmtDlSize(m.sizeMB)})`; msel.appendChild(o) }
  msel.value = activeWhisper()
  // langues en toutes lettres
  const lsel = $('trLang'); const cur = lsel.value || 'auto'; lsel.innerHTML = ''
  for (const [code, key] of TR_LANGS) { const o = document.createElement('option'); o.value = code; o.textContent = t(key); lsel.appendChild(o) }
  lsel.value = cur
  $('trSpeakers').value = localStorage.getItem('trSpeakers') || '0'
}
const TR_LANGS = [['auto', 'langAuto'], ['fr', 'langFr'], ['en', 'langEn'], ['es', 'langEs'], ['de', 'langDe'], ['it', 'langIt'], ['pt', 'langPt'], ['ja', 'langJa'], ['zh', 'langZh'], ['ru', 'langRu'], ['ar', 'langAr'], ['he', 'langHe']]
let trTracks = []
$('trModel').addEventListener('change', () => setActiveWhisper($('trModel').value))
function closeTranscribe() { if (!trBusy) trModal.classList.add('hidden') }

$('trOpenSettings').addEventListener('click', () => { trModal.classList.add('hidden'); openSettings() })
$('trClose').addEventListener('click', () => {
  if (trBusy) { window.api.whisperCancel(); trBusy = false; $('trStatus').textContent = t('trCancelled'); $('trClose').textContent = t('close'); $('trGo').disabled = false }
  else closeTranscribe()
})
$('trGo').addEventListener('click', runTranscribe)
window.api.onWhisperProgress((p) => {
  if (!p || !trBusy) return // n'affiche que pendant un run de transcription
  if (p.phase === 'extract') { $('trBar').style.width = '0%'; $('trStatus').textContent = t('trPhaseExtract') }
  else if (p.phase === 'transcribe') { $('trBar').style.width = Math.max(0, Math.min(100, p.pct || 0)) + '%'; $('trStatus').textContent = t('trTranscribing', p.pct || 0) }
})

async function runTranscribe() {
  if (trBusy) return
  const model = $('trModel').value || activeWhisper()
  if (!model) { toast(t('trNeedModel')); return }
  const lang = $('trLang').value
  const numSpeakers = Number($('trSpeakers').value) || 0
  localStorage.setItem('trSpeakers', String(numSpeakers))
  const tr = trTracks[Number($('trInTrack').value) || 0] || trTracks[0] || { source: project.videoPath, aIndex: 0 }
  trBusy = true; $('trGo').disabled = true; $('trClose').textContent = t('cancel')
  try {
    $('trStatus').textContent = t('trTranscribing', 0)
    const r = await window.api.whisperTranscribe({ source: tr.source, aIndex: tr.aIndex, model, language: lang, numSpeakers })
    if (!r || r.error) {
      const map = { 'no-engine': 'trNeedEngine', 'no-model': 'trNeedModel', 'no-source': 'trNeedVideo' }
      toast(t(map[r && r.error] || 'trFailed'))
      $('trStatus').textContent = t('trFailed')
      return
    }
    const n = r.segments ? buildLinesFromSegments(r.segments) : (importSubsText(r.srt || ''), 0)
    $('trBar').style.width = '100%'
    $('trStatus').textContent = t('trImported', n || 0)
    trModal.classList.add('hidden')
  } finally {
    trBusy = false; $('trGo').disabled = false; $('trClose').textContent = t('close')
  }
}

// découpe un segment {start,end,text} en répliques courtes : les onomatopées / bruits
// entre parenthèses ou crochets (rires, musique, soupir…) deviennent des réacs séparées,
// le texte parlé est coupé aux phrases pour éviter les pavés. Durées proportionnelles.
function segToChunks(text) {
  const chunks = []
  const re = /\(([^)]{1,60})\)|\[([^\]]{1,60})\]|♪([^♪]{0,60})♪/g
  let last = 0, m
  const pushSpoken = (s) => {
    s = s.trim(); if (!s) return
    const parts = s.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean)
    for (const p of (parts.length ? parts : [s])) chunks.push({ reac: false, text: p })
  }
  while ((m = re.exec(text))) {
    pushSpoken(text.slice(last, m.index))
    const inner = (m[1] || m[2] || m[3] || '').trim()
    if (inner) chunks.push({ reac: true, text: '(' + inner.toLowerCase() + ')' })
    last = re.lastIndex
  }
  pushSpoken(text.slice(last))
  return chunks
}

function buildLinesFromSegments(segments) {
  if (!segments || !segments.length) { toast(t('trNone')); return 0 }
  pushUndo()
  const speakerChar = new Map()
  const charFor = (sp) => {
    const key = sp == null ? 0 : sp
    if (speakerChar.has(key)) return speakerChar.get(key)
    const name = t('speakerName', key + 1)
    let c = project.characters.find((x) => x.name === name)
    if (!c) {
      c = { id: uid(), name, color: PALETTE[project.characters.length % PALETTE.length], prefTrack: clamp(key, 0, MAX_TRACKS - 1) }
      project.characters.push(c)
    }
    speakerChar.set(key, c.id)
    return c.id
  }
  // crée d'abord un personnage par locuteur (ordre d'apparition) et ADAPTE le nombre
  // de pistes AVANT de placer les répliques (pour que findFreeTrack ait les lanes)
  for (const seg of segments) charFor(seg.speaker)
  project.tracks = clamp(Math.max(1, speakerChar.size), 1, MAX_TRACKS)
  let added = 0
  for (const seg of segments) {
    const cid = charFor(seg.speaker)
    const chunks = segToChunks(String(seg.text || ''))
    if (!chunks.length) continue
    const a0 = Math.max(0, Number(seg.start) || 0)
    const b0 = Math.max(a0 + 0.2, Number(seg.end) || a0 + 0.6)
    // poids par longueur (réac = poids minimal) pour répartir la durée du segment
    const w = chunks.map((c) => Math.max(c.reac ? 2 : 4, c.text.length))
    const tot = w.reduce((s, x) => s + x, 0) || 1
    let cur = a0
    chunks.forEach((c, i) => {
      const span = (b0 - a0) * (w[i] / tot)
      const a = cur, b = Math.max(a + 0.2, cur + span); cur = b
      const line = { id: uid(), characterId: cid, track: findFreeTrack(a, b, cid), words: splitWords(c.text, a, b) }
      if (c.reac) line.kind = 'reac'
      project.lines.push(line); added++
    })
  }
  // assez de pistes pour tous les locuteurs, puis rafraîchir l'UI
  const maxUsed = project.lines.reduce((mx, l) => Math.max(mx, l.track || 0), -1)
  project.tracks = clamp(Math.max(project.tracks, maxUsed + 1), 1, MAX_TRACKS)
  if (!getChar(selectedCharId)) selectedCharId = project.characters[0]?.id || null
  renderChars(); applyBandHeight(); buildInsTrackOptions(); refreshTrackCountUI(); buildLineFilterOptions(); refreshInspector(); renderLinesLog()
  markDirty()
  return added
}


// ============================================================ Paramètres (capture + modèles + séparation)
const setModal = $('settingsModal')
let sepActive = false

function setDl(on, msg) {
  $('setProgress').classList.toggle('hidden', !on)
  $('setStatus').textContent = msg || ''
  if (!on) $('setBar').style.width = '0%'
}
// estimation de taille de téléchargement lisible (Mo / Go) selon la langue
function fmtDlSize(mb) {
  if (!mb) return '?'
  if (mb >= 1000) { let s = (mb / 1000).toFixed(1); if (lang !== 'en') s = s.replace('.', ',') // virgule décimale (fr/es)
    return s.replace(/[.,]0$/, '') + ' ' + t('unitGB') }
  return Math.round(mb) + ' ' + t('unitMB')
}
function saveAudioCfg() { window.api.audioConfigSet({ api: audioCfg.api, device: audioCfg.device, deviceLabel: audioCfg.deviceLabel, output: audioCfg.output, outputLabel: audioCfg.outputLabel, recOffsetMs: audioCfg.recOffsetMs || 0 }) }

// ---- préchargement Paramètres : listes en cache pour un affichage instantané ----
// Les deviceId de Chromium changent d'une session à l'autre (surtout sous file://) :
// on mémorise aussi le NOM du périphérique et on le retrouve par nom si l'id a changé.
let capInDevs = []  // périphériques d'entrée (audioinput) en cache
let capOutDevs = [] // périphériques de sortie (audiooutput) en cache
const modelCache = { trEngine: null, trModels: null, sepModels: null, python: null }

function pickDevice(devs, id, label) {
  return devs.find((d) => d.deviceId && d.deviceId === id) || (label ? devs.find((d) => d.label && d.label === label) : null) || null
}
async function currentInputId(id, label) {
  let devs = []
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput') } catch {}
  const m = pickDevice(devs, id, label)
  return m ? m.deviceId : null
}
// met en cache les listes de périphériques et réconcilie les choix mémorisés par nom
async function refreshDeviceCaches() {
  let devs = []
  try { devs = await navigator.mediaDevices.enumerateDevices() } catch {}
  capInDevs = devs.filter((d) => d.kind === 'audioinput')
  capOutDevs = devs.filter((d) => d.kind === 'audiooutput')
  const mi = pickDevice(capInDevs, audioCfg.device, audioCfg.deviceLabel)
  if (mi && mi.deviceId !== audioCfg.device) { audioCfg.device = mi.deviceId; if (mi.label) audioCfg.deviceLabel = mi.label; saveAudioCfg() }
  const mo = pickDevice(capOutDevs, audioCfg.output, audioCfg.outputLabel)
  if (mo && mo.deviceId !== audioCfg.output) { audioCfg.output = mo.deviceId; if (mo.label) audioCfg.outputLabel = mo.label; saveAudioCfg() }
  applyOutputSink()
}
// ouvre le micro mémorisé (id exact) ; si l'id a changé entre sessions, le retrouve par nom
async function openMic(base) {
  const getAudio = (c) => navigator.mediaDevices.getUserMedia({ audio: c })
  if (!audioCfg.device && !audioCfg.deviceLabel) return getAudio(base)
  try { return await getAudio({ ...base, deviceId: { exact: audioCfg.device } }) }
  catch {
    const id = await currentInputId(audioCfg.device, audioCfg.deviceLabel) // la tentative a accordé la permission → libellés lisibles
    if (id && id !== audioCfg.device) { audioCfg.device = id; saveAudioCfg() }
    try { return id ? await getAudio({ ...base, deviceId: { exact: id } }) : await getAudio(base) }
    catch { return getAudio(base) }
  }
}
// au démarrage : débloque les noms de périphériques (accès micro bref) + précharge les listes
async function preloadSettings() {
  refreshTrCache(); refreshSepCache() // modèles (IPC + fs), en tâche de fond
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((tr) => tr.stop()) } catch {}
  await refreshDeviceCaches()
}

async function fillCaptureDevices() {
  const api = $('capApi').value
  const devSel = $('capDevice')
  devSel.innerHTML = ''
  $('capNote').textContent = ''
  if (api === 'system') {
    const devs = capInDevs // cache préchargé (affichage instantané)
    if (!devs.some((d) => d.label)) $('capNote').textContent = t('capGrantMic')
    const def = document.createElement('option'); def.value = ''; def.textContent = t('capDefault'); devSel.appendChild(def)
    for (const d of devs) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || d.deviceId.slice(0, 10); devSel.appendChild(o) }
    const m = pickDevice(devs, audioCfg.device, audioCfg.deviceLabel)
    if (m) {
      devSel.value = m.deviceId
      if (m.deviceId !== audioCfg.device || (m.label && m.label !== audioCfg.deviceLabel)) { audioCfg.device = m.deviceId; if (m.label) audioCfg.deviceLabel = m.label; saveAudioCfg() }
    } else { devSel.value = audioCfg.device || '' }
  } else {
    const r = await window.api.listCaptureDevices(api)
    const devs = (r && r.devices) || []
    if (!r || !r.available) $('capNote').textContent = t('capNoBackend')
    for (const name of devs) { const o = document.createElement('option'); o.value = name; o.textContent = name; devSel.appendChild(o) }
    if (!devs.length) { const o = document.createElement('option'); o.value = ''; o.textContent = t('capNoDevices'); devSel.appendChild(o) }
    if (devs.length) {
      // backend dispo : on garde le périphérique mémorisé s'il existe, sinon le 1er
      devSel.value = devs.includes(audioCfg.device) ? audioCfg.device : devs[0]
      audioCfg.device = devSel.value || null
    } else {
      // backend momentanément indisponible : ne pas écraser le choix mémorisé
      devSel.value = ''
    }
  }
}

// ---- sortie audio : sélection du périphérique de lecture + test (retour audio + visuel) ----
function fillOutputDevices() {
  const sel = $('outDevice')
  sel.innerHTML = ''
  const devs = capOutDevs // cache préchargé (affichage instantané)
  $('outNote').textContent = devs.some((d) => d.label) ? '' : t('capGrantMic')
  const def = document.createElement('option'); def.value = ''; def.textContent = t('capDefault'); sel.appendChild(def)
  for (const d of devs) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || d.deviceId.slice(0, 10); sel.appendChild(o) }
  const m = pickDevice(devs, audioCfg.output, audioCfg.outputLabel)
  if (m) {
    sel.value = m.deviceId
    if (m.deviceId !== audioCfg.output || (m.label && m.label !== audioCfg.outputLabel)) { audioCfg.output = m.deviceId; if (m.label) audioCfg.outputLabel = m.label; saveAudioCfg(); applyOutputSink() }
  } else { sel.value = '' } // on garde le choix mémorisé (audioCfg.output) même s'il n'est pas listé
}

// route la lecture vidéo vers le périphérique de sortie choisi (défaut si vide)
async function applyOutputSink() {
  if (!video || typeof video.setSinkId !== 'function') return
  try { await video.setSinkId(audioCfg.output || '') } catch {}
}

let outTestState = null
function stopOutputTest() {
  if (!outTestState) return
  cancelAnimationFrame(outTestState.raf)
  try { if (outTestState.audioEl) { outTestState.audioEl.pause(); outTestState.audioEl.srcObject = null } } catch {}
  try { outTestState.stream.getTracks().forEach((tr) => tr.stop()) } catch {}
  try { outTestState.ac.close() } catch {}
  $('outMeterFill').style.width = '0%'
  $('outTest').textContent = t('outTestBtn')
  outTestState = null
}
// monitoring « à la Discord » : capte l'entrée choisie (ex. in 1L MOTU) et la renvoie
// vers la sortie choisie, avec un vumètre qui suit le niveau du micro en direct
async function toggleOutputTest() {
  if (outTestState) { stopOutputTest(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  let stream
  try { stream = await openMic(base) } catch { toast(t('recMicDenied')); return }
  const ac = makeAcForStream(stream) // même taux que l'entrée (sinon pitch)
  const src = ac.createMediaStreamSource(stream)
  const mono = toDualMono(ac, src) // mono (canal gauche) entendu sur L et R
  const analyser = ac.createAnalyser(); analyser.fftSize = 512
  mono.connect(analyser)
  let audioEl = null
  if (typeof ac.setSinkId === 'function') {
    // route direct vers la sortie choisie : évite le MediaStreamDestination + <audio>,
    // autre cause possible de transposition (pitch)
    try { if (audioCfg.output) await ac.setSinkId(audioCfg.output) } catch {}
    analyser.connect(ac.destination)
  } else {
    const dest = ac.createMediaStreamDestination()
    analyser.connect(dest)
    audioEl = new Audio(); audioEl.srcObject = dest.stream
    try { if (audioEl.setSinkId && audioCfg.output) await audioEl.setSinkId(audioCfg.output) } catch {}
    try { await audioEl.play() } catch {}
  }
  const buf = new Uint8Array(analyser.frequencyBinCount)
  const fill = $('outMeterFill')
  const tick = () => {
    analyser.getByteTimeDomainData(buf)
    let peak = 0; for (const v of buf) { const d = Math.abs(v - 128); if (d > peak) peak = d }
    fill.style.width = Math.min(100, (peak / 128) * 320) + '%'
    outTestState.raf = requestAnimationFrame(tick)
  }
  outTestState = { ac, audioEl, stream, raf: requestAnimationFrame(tick) }
  $('outTest').textContent = t('outTestStop')
}

// ---- modèles actifs (persistés localement), dropdowns qui ne montrent que l'installé ----
const activeWhisper = () => localStorage.getItem('trActiveModel') || ''
const setActiveWhisper = (m) => localStorage.setItem('trActiveModel', m)
const activeSep = () => localStorage.getItem('sepActiveModel') || ''
const setActiveSep = (m) => localStorage.setItem('sepActiveModel', m)

function fillActiveDropdown(sel, models, getActive, setActive) {
  sel.innerHTML = ''
  const installed = models.filter((m) => m.present)
  for (const m of installed) { const o = document.createElement('option'); o.value = m.model; o.textContent = m.label || m.model; sel.appendChild(o) }
  if (installed.length) {
    if (!installed.some((m) => m.model === getActive())) setActive(installed[0].model)
    sel.value = getActive(); sel.disabled = false
  } else { const o = document.createElement('option'); o.value = ''; o.textContent = t('mdlNone'); sel.appendChild(o); sel.disabled = true }
}

// une ligne de modèle : nom · taille · bouton Installer / Désinstaller
function modelRow(m, onInstall, onUninstall, canInstall) {
  const row = document.createElement('div'); row.className = 'model-row' + (m.present ? ' installed' : '')
  const nm = document.createElement('span'); nm.className = 'mdl-name'; nm.textContent = m.label || m.model
  const stt = document.createElement('span'); stt.className = 'mdl-state'; stt.textContent = m.present ? fmtDlSize(m.sizeMB) : '~' + fmtDlSize(m.estMB)
  const sp = document.createElement('div'); sp.className = 'spacer'
  const btn = document.createElement('button')
  btn.textContent = m.present ? t('mdlUninstall') : t('mdlInstall')
  if (!m.present && canInstall === false) { btn.disabled = true; btn.title = t('sepNoPython') }
  btn.addEventListener('click', () => (m.present ? onUninstall(btn) : onInstall(btn)))
  row.append(nm, stt, sp, btn)
  return row
}

// ligne « Moteur » : peinture depuis le cache (modelCache.trEngine)
function paintTrEngine() {
  const el = $('trEngineRow'); if (!el) return
  const st = modelCache.trEngine || { installed: false, python: null }
  el.className = 'model-row' + (st.installed ? ' installed' : '')
  el.innerHTML = ''
  const nm = document.createElement('span'); nm.className = 'mdl-name'; nm.textContent = t('engName')
  const stt = document.createElement('span'); stt.className = 'mdl-state'; stt.textContent = st.installed ? t('engInstalled') : (st.python ? t('engNotInstalled') : t('sepNoPython'))
  const sp = document.createElement('div'); sp.className = 'spacer'
  const btn = document.createElement('button')
  btn.textContent = st.installed ? t('mdlUninstall') : t('mdlInstall')
  if (!st.installed && !st.python) { btn.disabled = true; btn.title = t('sepNoPython') }
  btn.addEventListener('click', async () => {
    btn.disabled = true
    if (st.installed) { await window.api.whisperEngineUninstall(); refreshTrCache() }
    else { setDl(true, t('engInstalling')); const r = await window.api.whisperEngineInstall(); setDl(false, ''); toast(r && r.ok ? t('engInstalled') : t(r && r.error === 'no-python' ? 'sepNoPython' : 'engInstallFail')); refreshTrCache() }
  })
  el.append(nm, stt, sp, btn)
}
// peinture instantanée de la liste des modèles de transcription (depuis le cache)
function paintTrModels() {
  paintTrEngine()
  const list = $('trModelList'); if (!list) return
  list.innerHTML = ''
  const models = modelCache.trModels || []
  const python = modelCache.python
  for (const m of models) {
    list.appendChild(modelRow(m,
      async (btn) => { btn.disabled = true; setDl(true, t('trDownloading', 0)); const r = await window.api.whisperInstallModel(m.model); setDl(false, ''); toast(r && r.ok ? t('mdlDone') : t(r && r.error === 'no-python' ? 'sepNoPython' : 'trFailed')); refreshTrCache() },
      async () => { await window.api.whisperDeleteModel(m.model); refreshTrCache() },
      !!python))
  }
  fillActiveDropdown($('trActive'), models, activeWhisper, setActiveWhisper)
}
// rafraîchit le cache transcription (IPC + fs) puis repeint si les Paramètres sont ouverts
async function refreshTrCache() {
  try { modelCache.trEngine = await window.api.whisperEngineStatus() } catch { modelCache.trEngine = { installed: false, python: null } }
  modelCache.python = modelCache.trEngine ? modelCache.trEngine.python : null
  try { modelCache.trModels = await window.api.whisperListModels() } catch { modelCache.trModels = [] }
  if (setModal && !setModal.classList.contains('hidden')) paintTrModels()
}
function renderTrModels() { paintTrModels(); return refreshTrCache() } // instantané (cache) puis MAJ

function paintSepModels() {
  const list = $('sepModelList'); if (!list) return
  list.innerHTML = ''
  const models = modelCache.sepModels || []
  const python = modelCache.python
  for (const m of models) {
    list.appendChild(modelRow(m,
      async (btn) => { btn.disabled = true; setDl(true, t('sepInstalling')); const r = await window.api.sepInstallModel(m.model); setDl(false, ''); toast(r && r.ok ? t('mdlDone') : t(r && r.error === 'no-python' ? 'sepNoPython' : 'sepInstallFail')); refreshSepCache() },
      async () => { await window.api.sepDeleteModel(m.model); refreshSepCache() },
      !!python))
  }
  fillActiveDropdown($('sepActive'), models, activeSep, setActiveSep)
}
async function refreshSepCache() {
  try { modelCache.sepModels = await window.api.sepListModels() } catch { modelCache.sepModels = [] }
  if (modelCache.python == null) { try { modelCache.python = (await window.api.detectPython()).python } catch {} }
  if (setModal && !setModal.classList.contains('hidden')) paintSepModels()
}
function renderSepModels() { paintSepModels(); return refreshSepCache() }

function openSettings() {
  setModal.classList.remove('hidden')
  $('capApi').value = audioCfg.api || 'system'
  $('recOffset').value = String(audioCfg.recOffsetMs || 0)
  setDl(false, '')
  // tout se peint immédiatement depuis les caches préchargés ; rafraîchissement en fond
  fillCaptureDevices(); fillOutputDevices(); renderTrModels(); renderSepModels()
}

$('capApi').addEventListener('change', () => { audioCfg.api = $('capApi').value; audioCfg.device = null; audioCfg.deviceLabel = null; saveAudioCfg(); resetMic(); fillCaptureDevices() })
$('capDevice').addEventListener('change', () => {
  const sel = $('capDevice'); const opt = sel.selectedOptions[0]
  audioCfg.device = sel.value || null
  audioCfg.deviceLabel = sel.value && opt ? opt.textContent : null // mémorise aussi le nom (id instable entre sessions)
  saveAudioCfg(); resetMic()
})
$('capRefresh').addEventListener('click', async () => { await refreshDeviceCaches(); fillCaptureDevices() })
$('outDevice').addEventListener('change', () => {
  const sel = $('outDevice'); const opt = sel.selectedOptions[0]
  audioCfg.output = sel.value || null
  audioCfg.outputLabel = sel.value && opt ? opt.textContent : null
  saveAudioCfg(); applyOutputSink()
})
$('outRefresh').addEventListener('click', async () => { await refreshDeviceCaches(); fillOutputDevices() })
$('recOffset').addEventListener('change', () => { audioCfg.recOffsetMs = clamp(Number($('recOffset').value) || 0, -500, 500); $('recOffset').value = String(audioCfg.recOffsetMs); saveAudioCfg() })
$('outTest').addEventListener('click', toggleOutputTest)
$('trActive').addEventListener('change', () => setActiveWhisper($('trActive').value))
$('sepActive').addEventListener('change', () => setActiveSep($('sepActive').value))
$('setClose').addEventListener('click', () => { stopOutputTest(); setModal.classList.add('hidden') })
window.api.onWhisperProgress((p) => {
  if (!p || $('setProgress').classList.contains('hidden')) return
  if (p.phase === 'download') { const pct = Math.max(0, Math.min(100, p.pct || 0)); $('setBar').style.width = pct + '%'; $('setStatus').textContent = t('trDownloading', pct) }
  else if (p.phase === 'unpack') { $('setStatus').textContent = t('mdlUnpacking') }
  else if (p.phase === 'install') { $('setStatus').textContent = p.text || t('engInstalling') }
})
window.api.onSepProgress((p) => {
  if (!p) return
  if (sepActive) { // modale « retirer les voix » en cours : statut par phase
    if (p.phase === 'extract') { $('sepBar').style.width = '0%'; $('sepStatus').textContent = t('sepPhaseExtract') }
    else if (p.phase === 'install') { $('sepStatus').textContent = t('sepPhaseEngine') }
    else if (p.phase === 'separate') { const pct = Math.max(0, Math.min(100, p.pct || 0)); $('sepBar').style.width = pct + '%'; $('sepStatus').textContent = t('sepPhaseSeparate', pct) }
    return
  }
  if ($('setProgress').classList.contains('hidden')) return // sinon = install/download depuis les Paramètres
  if (p.phase === 'download') { const pct = Math.max(0, Math.min(100, p.pct || 0)); $('setBar').style.width = pct + '%'; $('setStatus').textContent = t('trDownloading', pct) }
  else $('setStatus').textContent = p.text || t('sepInstalling')
})

// ---------- retrait des voix (séparation IA) : modale dédiée ----------
const sepModal = $('separateModal')
let sepBusy = false
let sepTracks = []

// pistes source possibles = les pistes audio du projet (les pistes embarquées
// incluent déjà l'audio de la vidéo — pas de doublon). Repli sur l'audio vidéo si
// aucune piste n'a encore été sondée. Partagé par les modales séparation + transcription.
function audioSourceOptions() {
  const tracks = project.audioTracks || []
  if (!tracks.length) return [{ label: t('sepTrackVideo'), source: project.videoPath, aIndex: 0 }]
  return tracks.map((a) => ({
    label: (a.label || baseName(a.path || '')) + (a.type === 'file' ? ` (${t('trackExternal')})` : ''),
    source: a.type === 'file' && a.path ? a.path : project.videoPath,
    aIndex: a.type === 'file' ? 0 : (a.index || 0),
  }))
}

async function openSeparateDialog() {
  if (!project.videoPath) { toast(t('loadVideoFirst')); return }
  sepModal.classList.remove('hidden')
  $('sepBar').style.width = '0%'; $('sepStatus').textContent = ''
  $('sepGo').disabled = false; $('sepCloseBtn').textContent = t('close')
  let models = []
  try { models = (await window.api.sepListModels()).filter((m) => m.present) } catch {}
  const ready = models.length > 0
  $('sepNotReady').classList.toggle('hidden', ready)
  $('sepReadyBody').classList.toggle('hidden', !ready)
  $('sepGo').classList.toggle('hidden', !ready)
  if (!ready) { $('sepNotReadyMsg').textContent = t('sepNeedModel'); return }
  const msel = $('sepRunModel'); msel.innerHTML = ''
  for (const m of models) { const o = document.createElement('option'); o.value = m.model; o.textContent = m.label || m.model; msel.appendChild(o) }
  msel.value = models.some((m) => m.model === activeSep()) ? activeSep() : models[0].model
  sepTracks = audioSourceOptions()
  const tsel = $('sepInTrack'); tsel.innerHTML = ''
  sepTracks.forEach((o, i) => { const op = document.createElement('option'); op.value = String(i); op.textContent = o.label; tsel.appendChild(op) })
  $('sepOutName').value = t('sepTrackName')
  try { $('sepOutDir').value = await window.api.sepDefaultDir(projectPath) } catch { $('sepOutDir').value = '' }
}

$('sepOpenSettings').addEventListener('click', () => { sepModal.classList.add('hidden'); openSettings() })
$('sepOutBrowse').addEventListener('click', async () => { const d = await window.api.pickDirectory($('sepOutDir').value || ''); if (d) $('sepOutDir').value = d })
$('sepCloseBtn').addEventListener('click', () => {
  if (sepBusy) { window.api.sepCancel(); sepBusy = false; sepActive = false; $('sepStatus').textContent = t('sepCancelled'); $('sepGo').disabled = false; $('sepCloseBtn').textContent = t('close') }
  else if (!sepBusy) sepModal.classList.add('hidden')
})
$('sepGo').addEventListener('click', doSeparate)

async function doSeparate() {
  if (sepBusy) return
  const model = $('sepRunModel').value
  if (!model) { toast(t('sepNeedModel')); return }
  setActiveSep(model)
  const tr = sepTracks[Number($('sepInTrack').value) || 0] || sepTracks[0]
  const destBase = (($('sepOutName').value || '').trim()) || t('sepTrackName')
  const destDir = $('sepOutDir').value || ''
  sepBusy = true; sepActive = true
  $('sepGo').disabled = true; $('sepCloseBtn').textContent = t('cancel')
  $('sepBar').style.width = '0%'; $('sepStatus').textContent = t('sepPhaseStart')
  const r = await window.api.sepRun({ source: tr.source, aIndex: tr.aIndex, projectPath, model, destBase, destDir })
  sepBusy = false; sepActive = false
  $('sepGo').disabled = false; $('sepCloseBtn').textContent = t('close')
  if (!r || r.error) {
    const map = { 'no-model': 'sepNeedModel', 'no-engine': 'sepNeedModel', 'no-python': 'sepNoPython', 'no-source': 'sepNoSource', 'extract-failed': 'sepExtractFail' }
    const known = map[r && r.error]
    $('sepStatus').textContent = known ? t(known) : t('sepFailed') + (r && r.error ? ' — ' + String(r.error).slice(0, 140) : '')
    return
  }
  $('sepBar').style.width = '100%'; $('sepStatus').textContent = t('sepDone')
  await addExternalAudio(r.path, destBase, { voiceless: true }) // marque la piste générée « sans voix »
  toast(t('sepDone'))
  setTimeout(() => { if (!sepBusy) sepModal.classList.add('hidden') }, 700)
}

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

$('btnTogglePlans').addEventListener('click', () => {
  const panel = $('plansPanel')
  panel.classList.toggle('hidden')
  $('btnTogglePlans').classList.toggle('active', !panel.classList.contains('hidden'))
})
$('btnAddPlan').addEventListener('click', addPlanAtPlayhead)
$('btnDetectPlans').addEventListener('click', openDetectModal)

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

// piste d'accueil d'une nouvelle réplique : la piste préférée du personnage
// (panneau Personnages) prime si elle est affichée ; sinon d'abord les pistes où le
// personnage figure déjà (de la plus utilisée à la moins), puis les autres dans
// l'ordre — la première libre sur [start, end[ gagne ; tout occupé → piste du
// personnage, sinon 1re
function findFreeTrack(start, end, characterId) {
  const pref = getChar(characterId)?.prefTrack
  if (pref != null && pref < laneCount()) return pref
  const counts = new Map()
  for (const l of project.lines) if (l.characterId === characterId) counts.set(l.track, (counts.get(l.track) || 0) + 1)
  const charTracks = [...counts.keys()].filter((tr) => tr < laneCount()).sort((a, b) => counts.get(b) - counts.get(a) || a - b)
  const rest = Array.from({ length: laneCount() }, (_, i) => i).filter((tr) => !charTracks.includes(tr))
  for (const tr of [...charTracks, ...rest]) {
    const busy = project.lines.some(
      (l) => l.track === tr && lineStart(l) < end && lineEnd(l) > start
    )
    if (!busy) return tr
  }
  return charTracks[0] ?? 0
}

function addLineAt(start, track, text, dur) {
  pushUndo()
  if (!project.characters.length) addCharacter()
  start = Math.max(0, start)
  const end = start + (dur || NEW_LINE_DUR)
  const characterId = selectedCharId || project.characters[0].id
  const line = {
    id: uid(),
    characterId,
    track: track == null ? findFreeTrack(start, end, characterId) : track,
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
  font: $('insFont'),
  track: $('insTrack'),
  entry: $('insEntry'),
  exit: $('insExit'),
  voiceOff: $('insVoiceOff'),
  text: $('insText'),
  start: $('insStart'),
  end: $('insEnd'),
}

const selectedLines = () => project.lines.filter((l) => selectedIds.has(l.id))

// mode N répliques : actions en lot (police, voix off, personnage) avec état
// indéterminé quand les valeurs diffèrent
function refreshMultiInspector(lines) {
  $('insMultiCount').textContent = t('multiCount', lines.length)
  // personnage
  const charSel = $('insMultiChar')
  charSel.innerHTML = ''
  const chars = new Set(lines.map((l) => l.characterId))
  const mixedChar = chars.size > 1
  if (mixedChar) { const o = document.createElement('option'); o.value = '__mixed__'; o.textContent = t('multiMixed'); charSel.appendChild(o) }
  for (const c of project.characters) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; charSel.appendChild(o) }
  charSel.value = mixedChar ? '__mixed__' : [...chars][0]
  // police
  const fontSel = $('insMultiFont')
  fontSel.innerHTML = ''
  const fonts = project.fonts || []
  const fontVals = new Set(lines.map((l) => l.font || ''))
  const mixedFont = fontVals.size > 1
  const addF = (v, lbl) => { const o = document.createElement('option'); o.value = v; o.textContent = lbl; fontSel.appendChild(o) }
  if (mixedFont) addF('__mixed__', t('multiMixed'))
  addF('', t('fontDefault'))
  for (const name of BUNDLED_FONTS) addF(name, name)
  for (const f of fonts) addF(f.name, f.name)
  addF('__load__', t('fontLoad'))
  const only = [...fontVals][0]
  fontSel.value = mixedFont ? '__mixed__' : (allFontNames().includes(only) ? only : '')
  // piste : déplacer toutes les répliques vers une piste (état indéterminé si mélange)
  const trackSel = $('insMultiTrack')
  trackSel.innerHTML = ''
  const tracks = new Set(lines.map((l) => l.track || 0))
  const mixedTrack = tracks.size > 1
  if (mixedTrack) { const o = document.createElement('option'); o.value = '__mixed__'; o.textContent = t('multiMixed'); trackSel.appendChild(o) }
  for (let i = 0; i < laneCount(); i++) { const o = document.createElement('option'); o.value = String(i); o.textContent = t('track', i + 1); trackSel.appendChild(o) }
  trackSel.value = mixedTrack ? '__mixed__' : String([...tracks][0])
  // voix off : actif si toutes ON, indéterminé si mélange
  const off = lines.filter((l) => l.voiceOff).length
  const btn = $('insMultiVoiceOff')
  btn.classList.toggle('active', off === lines.length)
  btn.classList.toggle('mixed', off > 0 && off < lines.length)
}

let insShownId = null // réplique affichée dans l'inspecteur : si elle change, les
// champs sont réécrits même focalisés (la garde ne protège que la frappe en cours)
function refreshInspector() {
  const line = singleSelected()
  const multi = !line && selectedIds.size > 1
  ins.el.classList.toggle('empty', !line && !multi)
  ins.el.classList.toggle('multi', multi)
  scheduleLinesLog()
  if (activeTab === 'rec') { updateRecCharBadge(); renderRecCharList() } // suit l'ajout/retrait de personnages
  if (multi) { insShownId = null; refreshMultiInspector(selectedLines()); return }
  if (!line) {
    insShownId = null
    $('insEmpty').textContent = t('insEmpty')
    return
  }
  const changed = insShownId !== line.id
  insShownId = line.id
  ins.char.innerHTML = ''
  for (const c of project.characters) {
    const o = document.createElement('option')
    o.value = c.id
    o.textContent = c.name
    ins.char.appendChild(o)
  }
  ins.char.value = line.characterId
  ins.font.value = allFontNames().includes(line.font) ? line.font : ''
  ins.track.value = String(line.track)
  ins.entry.value = line.entry || ''
  ins.exit.value = line.exit || ''
  ins.voiceOff.classList.toggle('active', !!line.voiceOff)
  if (changed || document.activeElement !== ins.text) ins.text.value = line.words.map((w) => w.text).join(' ')
  if (changed || document.activeElement !== ins.start) ins.start.value = formatTc(lineStart(line), project.fps)
  if (changed || document.activeElement !== ins.end) ins.end.value = formatTc(lineEnd(line), project.fps)
}

ins.char.addEventListener('change', () => {
  const l = singleSelected()
  if (l) { pushUndo(); l.characterId = ins.char.value; markDirty() }
})
ins.track.addEventListener('change', () => {
  const l = singleSelected()
  if (l) { pushUndo(); l.track = Number(ins.track.value); markDirty() }
})
// police de la réplique : '' = défaut, '__load__' = charger un TTF/OTF, sinon nom
ins.font.addEventListener('change', async () => {
  const l = singleSelected()
  if (!l) return
  let v = ins.font.value
  if (v === '__load__') {
    const name = await loadFontFile()
    populateFontSelects()
    if (!name) { ins.font.value = l.font || ''; return }
    v = name
  }
  pushUndo()
  if (v) l.font = v
  else delete l.font
  ins.font.value = v
  markDirty()
})
// police par défaut globale de la bande (s'applique aux répliques sans police propre)
$('defFont').addEventListener('change', async () => {
  let v = $('defFont').value
  if (v === '__load__') {
    const name = await loadFontFile()
    populateFontSelects()
    if (!name) return
    v = name
  }
  pushUndo()
  project.defaultFont = v || null
  populateFontSelects()
  markDirty()
})

// ---------- actions en lot (mode N répliques) ----------
$('insMultiChar').addEventListener('change', () => {
  const v = $('insMultiChar').value
  if (v === '__mixed__') return
  pushUndo()
  selectedLines().forEach((l) => { l.characterId = v })
  markDirty()
  refreshInspector()
})
$('insMultiFont').addEventListener('change', async () => {
  let v = $('insMultiFont').value
  if (v === '__mixed__') { refreshInspector(); return }
  if (v === '__load__') {
    const name = await loadFontFile()
    populateFontSelects()
    if (!name) { refreshInspector(); return }
    v = name
  }
  pushUndo()
  selectedLines().forEach((l) => { if (v) l.font = v; else delete l.font })
  markDirty()
  refreshInspector()
})
$('insMultiTrack').addEventListener('change', () => {
  const v = $('insMultiTrack').value
  if (v === '__mixed__') return
  pushUndo()
  selectedLines().forEach((l) => { l.track = Number(v) })
  markDirty()
  refreshInspector()
})
// voix off en lot : si toutes ne sont pas déjà ON → tout activer, sinon tout désactiver
$('insMultiVoiceOff').addEventListener('click', () => {
  const lines = selectedLines()
  if (!lines.length) return
  const allOn = lines.every((l) => l.voiceOff)
  pushUndo()
  lines.forEach((l) => { if (allOn) delete l.voiceOff; else l.voiceOff = true })
  markDirty()
  refreshInspector()
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
  panelH = null // changer le nombre de pistes recale le dock pour afficher toutes les pistes
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
// non sérialisées en DETX (restent internes au format .rythmo).
const loopDur = (lp) => Math.max(0, lp.end - lp.start)
const sortedLoops = () => [...project.loops].sort((a, b) => a.start - b.start)

// stats d'une scène calculées à la volée (jamais stockées) : une réplique compte
// pour la scène si son début tombe dans [start, end) ; bonus = personnages distincts
function loopStats(lp) {
  const inScene = project.lines.filter((l) => l.words.length && lineStart(l) >= lp.start && lineStart(l) < lp.end)
  return { lines: inScene.length, chars: new Set(inScene.map((l) => l.characterId)).size }
}

// une boucle est « hors normes » uniquement si un segment OUT est trop court. Une
// scène normale n'est jamais signalée, même très longue (ce n'est pas un problème).
function loopWarn(lp) {
  return lp.type === 'out' && loopDur(lp) < LOOP_OUT_MIN_SEC
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

    const nm = document.createElement('span')
    nm.className = 'lp-name'
    nm.textContent = lp.name

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
    // renommer / supprimer au style des lignes Personnages (✎ / ✕)
    const startRename = () => inlineRename(nm, lp.name, (nv) => { pushUndo(); lp.name = nv; markDirty() }, renderLoopsPanel)
    const edit = rowIconButton('edit', t('loopRename'), startRename)
    const del = rowIconButton('del', t('loopDelete'), () => {
      pushUndo(); project.loops = project.loops.filter((k) => k.id !== lp.id); renderLoopsPanel(); markDirty()
    })
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename() })

    // ligne 1 : nom + actions
    const top = document.createElement('div')
    top.className = 'lp-top'
    top.append(nm, setStart, setEnd, out, edit, del)

    // ligne 2 : méta-stats calculées à la volée (plage · durée · répliques · persos)
    const st = loopStats(lp)
    const meta = document.createElement('div')
    meta.className = 'lp-meta'
    const sep = () => { const s = document.createElement('span'); s.className = 'lp-sep'; s.textContent = '·'; return s }
    const range = document.createElement('span')
    range.className = 'lp-range'
    range.textContent = `${formatTcShort(lp.start)} → ${formatTcShort(lp.end)}`
    const dur = document.createElement('span')
    dur.className = 'lp-dur' + (loopWarn(lp) ? ' warn' : '')
    dur.textContent = formatTcShort(loopDur(lp))
    dur.title = loopWarn(lp) ? t('loopOutTooShort', LOOP_OUT_MIN_SEC) : ''
    const cnt = document.createElement('span')
    cnt.className = 'lp-count'
    cnt.textContent = t('loopStatLines', st.lines)
    meta.append(range, sep(), dur, sep(), cnt)
    if (st.chars > 0) meta.append(sep(), Object.assign(document.createElement('span'), { className: 'lp-count', textContent: t('loopStatChars', st.chars) }))

    row.append(top, meta)
    row.addEventListener('click', () => { video.pause(); scrubTo(lp.start) })
    list.appendChild(row)
  }
}

// dessin des boucles sur la bande (overlay éditeur) : bornes verticales + onglet
// nom DANS la règle (au-dessus du trait) + liseré le long du haut des pistes. Visualisation seule.
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
    // onglet du nom DANS la règle (au-dessus du trait), pour ne pas masquer le nom du perso
    ctx.fillStyle = col
    ctx.beginPath(); ctx.roundRect(tabX, 2, tabW, RULER_H - 5, 3); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, tabX + 5, 2 + (RULER_H - 5) / 2)
  }
  ctx.restore()
}

// ---------- Plans (changements de plan) — marqueurs ponctuels, panneau dédié ----------
const sortedPlans = () => [...(project.plans || [])].sort((a, b) => a.time - b.time)

function addPlanAt(time, name) {
  const pl = { id: uid(), time: Math.max(0, time), name: name || t('planName', (project.plans?.length || 0) + 1) }
  project.plans.push(pl)
  return pl
}

function addPlanAtPlayhead() {
  pushUndo()
  addPlanAt(effectiveTime())
  renderPlansPanel()
  markDirty()
}

function renderPlansPanel() {
  const list = $('plansList')
  if (!list) return
  list.innerHTML = ''
  const plans = sortedPlans()
  $('plansEmpty').classList.toggle('hidden', plans.length > 0)
  for (const pl of plans) {
    const row = document.createElement('div')
    row.className = 'plan-row'
    const tc = document.createElement('span')
    tc.className = 'pl-tc'
    tc.textContent = formatTcShort(pl.time)
    const nm = document.createElement('span')
    nm.className = 'pl-name'
    nm.textContent = pl.name
    // renommer / supprimer au style des lignes Personnages (✎ / ✕)
    const startRename = () => inlineRename(nm, pl.name, (nv) => { pushUndo(); pl.name = nv; markDirty() }, renderPlansPanel)
    const edit = rowIconButton('edit', t('planRename'), startRename)
    const del = rowIconButton('del', t('planDelete'), () => {
      pushUndo()
      project.plans = project.plans.filter((k) => k.id !== pl.id)
      renderPlansPanel()
      markDirty()
    })
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename() })
    row.append(tc, nm, edit, del)
    row.addEventListener('click', () => { video.pause(); scrubTo(pl.time) })
    list.appendChild(row)
  }
}

// marqueur de plan sur la bande : flèche vers le bas ancrée en haut + trait fin (standard industrie)
function drawPlans() {
  const plans = project.plans || []
  if (!plans.length) return
  const now = effectiveTime()
  const col = bandPal().planMark || '#e8a13a'
  ctx.save()
  for (const pl of plans) {
    const x = xAtTime(pl.time, now)
    if (x < -8 || x > cw + 8) continue
    ctx.strokeStyle = col
    ctx.globalAlpha = 0.4
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x + 0.5, RULER_H); ctx.lineTo(x + 0.5, ch); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = col
    const w = 5, top = 1, h = 10
    ctx.beginPath(); ctx.moveTo(x - w, top); ctx.lineTo(x + w, top); ctx.lineTo(x, top + h); ctx.closePath(); ctx.fill()
  }
  ctx.restore()
}

// chemin du proxy basse résolution s'il a été généré (feature Proxy) ; la détection
// l'utilise en priorité (analyse bien plus rapide). null = analyser la source.
let videoProxyPath = null
let usingProxy = false // le lecteur joue actuellement le proxy (et non la source)
let sourceVideoUrl = null // URL de la source, pour revenir si le proxy est invalide
let proxyToken = 0 // invalide une génération en cours si une autre vidéo est ouverte
let proxyActive = false // une génération de proxy est en cours (pour la pastille)

function showProxyStatus(txt) {
  const el = $('proxyStatus')
  el.innerHTML = ''
  const dot = document.createElement('span'); dot.className = 'px-dot'
  const t2 = document.createElement('span'); t2.textContent = txt
  el.append(dot, t2)
  el.classList.remove('hidden')
}
const hideProxyStatus = () => $('proxyStatus').classList.add('hidden')

// génère/réutilise le proxy en tâche de fond puis bascule le lecteur dessus (résolution
// seule ; durée et cadence identiques → les timecodes ne bougent pas). L'export, lui,
// repart toujours de project.videoPath (pleine qualité).
async function generateProxy(sourcePath) {
  if (!sourcePath) return
  const myToken = ++proxyToken
  videoProxyPath = null
  usingProxy = false
  proxyActive = true
  showProxyStatus(t('proxyGenerating', 0))
  let r
  try { r = await window.api.ensureProxy(sourcePath) } catch { r = null }
  if (myToken !== proxyToken) return // une autre vidéo a été ouverte entre-temps
  proxyActive = false
  hideProxyStatus()
  if (!r || r.error || !r.path) return // échec silencieux : on reste sur la source
  const url = await window.api.fileUrl(r.path)
  if (!url || myToken !== proxyToken) return
  // attend que la durée de la source soit connue (proxy en cache → retour quasi instantané,
  // parfois avant le chargement des métadonnées de la source) pour fiabiliser le garde-fou
  if (!videoInfo?.duration && video.readyState < 1) {
    await new Promise((res) => {
      const done = () => { video.removeEventListener('loadedmetadata', done); res() }
      video.addEventListener('loadedmetadata', done)
      setTimeout(done, 4000)
    })
    if (myToken !== proxyToken) return
  }
  const srcDur = videoInfo?.duration || video.duration || 0
  videoProxyPath = r.path
  const at = video.currentTime
  const wasPaused = video.paused
  usingProxy = true
  const onMeta = () => {
    video.removeEventListener('loadedmetadata', onMeta)
    // garde-fou : si la durée du proxy diffère trop de la source, on revient à la source
    if (srcDur && Math.abs((video.duration || 0) - srcDur) > 0.5) {
      usingProxy = false
      videoProxyPath = null
      if (sourceVideoUrl) video.src = sourceVideoUrl
      return
    }
    try { video.currentTime = at } catch {}
    if (!wasPaused) video.play().catch(() => {})
  }
  video.addEventListener('loadedmetadata', onMeta)
  video.src = url
}

// ---------- détection automatique des plans (ffmpeg select=scene) ----------
const detState = { running: false, cancelled: false }

function openDetectModal() {
  if (!project.videoPath) { toast(t('detNeedVideo')); return }
  $('detSens').value = '0.5'
  $('detSensVal').textContent = '0.50'
  $('detStatus').textContent = ''
  $('detBar').style.width = '0%'
  $('detGo').disabled = false
  $('plansModal').classList.remove('hidden')
}
function closeDetectModal() {
  if (detState.running) { detState.cancelled = true; window.api.detectCancel() }
  $('plansModal').classList.add('hidden')
}
$('detSens').addEventListener('input', () => { $('detSensVal').textContent = Number($('detSens').value).toFixed(2) })
$('detCancel').addEventListener('click', closeDetectModal)
$('plansModal').addEventListener('click', (e) => { if (e.target === $('plansModal')) closeDetectModal() })
window.api.onDetectProgress((frame) => {
  if (!detState.running) return
  const total = Math.max(1, Math.ceil(videoDur() * (project.fps || 25)))
  $('detBar').style.width = `${Math.min(99, Math.round((frame / total) * 100))}%`
  $('detStatus').textContent = t('detRunning')
})

async function runDetectScenes() {
  if (detState.running || !project.videoPath) return
  detState.running = true
  detState.cancelled = false
  $('detGo').disabled = true
  $('detStatus').textContent = t('detRunning')
  const threshold = Number($('detSens').value) || 0.5
  // analyse sur le proxy s'il existe (bien plus rapide, résultat quasi identique)
  const r = await window.api.detectScenes({ path: videoProxyPath || project.videoPath, threshold })
  detState.running = false
  $('detGo').disabled = false
  if (detState.cancelled) { $('detStatus').textContent = t('detCancelled'); return }
  if (r.error) { $('detStatus').textContent = r.error; toast(r.error); return }
  const fps = project.fps || 25
  const existing = (project.plans || []).map((p) => p.time)
  let added = 0
  pushUndo()
  for (const sec of (r.times || [])) {
    const time = Math.round(sec * fps) / fps // calé exactement sur l'image du cut
    if (existing.some((e) => Math.abs(e - time) < 0.2)) continue // dédoublonne vs plans déjà posés
    addPlanAt(time)
    existing.push(time)
    added++
  }
  markDirty()
  renderPlansPanel()
  $('detBar').style.width = '100%'
  $('detStatus').textContent = added ? t('detDone', added) : t('detNone')
  if ($('plansPanel').classList.contains('hidden')) $('btnTogglePlans').click() // montre le résultat
}
$('detGo').addEventListener('click', runDetectScenes)

// ============================================================ onglets + pistes audio/vidéo
// Onglet « Rythmo » = éditeur de bande. Onglet « Pistes » = timeline façon montage :
// piste vidéo de référence + pistes audio (embarquées + fichiers importés), avec le MÊME
// zoom / défilement / curseur que la bande rythmo. Glisser une piste audio fixe son offset.
// La piste « active » (haut-parleur) fournit la forme d'onde affichée sur la bande.
// Modèle : project.audioTracks = [{id, type:'embedded'|'file', index?, path?, offset, label,
// lang, codec, channels}] ; project.activeAudioId = piste active.
let activeTab = 'rythmo'
let selectedTrackId = null
const TRK_LANE_H = 56
// icônes monochromes (haut-parleur actif / muet) — remplacent les emoji 🔊/🔈
const SPK_ON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7"/><path d="M18.7 6a7 7 0 0 1 0 12"/></svg>'
const SPK_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5l4.5 5M21.5 9.5l-4.5 5"/></svg>'
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l1 12a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2l1-12"/><path d="M10 11v6M14 11v6"/></svg>'
// icône bouche = marqueur « piste voix par défaut » (monitoring doublage)
const VOICE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c4-4 14-4 18 0-4 4-14 4-18 0z"/><path d="M3 12h18"/></svg>'
const baseName = (p) => String(p || '').replace(/^.*[\\/]/, '')
const trackChannels = (n) => (n === 1 ? 'mono' : n === 2 ? 'stéréo' : n ? n + ' ch' : '')

const tcanvas = $('tracksCanvas')
const tctx = tcanvas.getContext('2d')
$('tracksPlayhead').style.left = '0px' // repositionnée chaque frame par drawTracks (timeline pleine largeur)
let tcw = 0, tch = 0

function setTab(name) {
  activeTab = (name === 'tracks' || name === 'rec') ? name : 'rythmo'
  const onTracks = activeTab === 'tracks'
  const onRec = activeTab === 'rec'
  document.body.classList.toggle('on-tracks', onTracks) // cache les contrôles rythmo, montre l'import audio
  document.body.classList.toggle('on-rec', onRec)
  $('tabRythmo').classList.toggle('active', activeTab === 'rythmo')
  $('tabTracks').classList.toggle('active', onTracks)
  $('tabRec').classList.toggle('active', onRec)
  $('bandWrap').classList.toggle('hidden', onTracks || onRec)
  $('inspector').classList.toggle('hidden', onTracks || onRec)
  $('tracksView').classList.toggle('hidden', !onTracks)
  $('recView').classList.toggle('hidden', !onRec)
  if (onTracks) { hideSubOverlay(); renderTracks() }
  if (onRec) { hideSubOverlay(); renderRecTab() }
  $('btnDub').classList.toggle('hidden', !dubVoicelessTrack()) // gating piste sans-voix (tous onglets)
  applyBandHeight() // hauteur du dock constante entre onglets + dimensionne le canvas visible
}
$('tabRythmo').addEventListener('click', () => setTab('rythmo'))
$('tabTracks').addEventListener('click', () => setTab('tracks'))
$('tabRec').addEventListener('click', () => setTab('rec'))

// lanes affichées : vidéo (référence) puis pistes audio
const trackLanes = () => [{ id: '__video__', kind: 'video' }, ...(project.audioTracks || [])]
const audioById = (id) => (project.audioTracks || []).find((a) => a.id === id) || null
function activeAudioTrack() {
  const list = project.audioTracks || []
  return audioById(project.activeAudioId) || list.find((a) => a.type === 'embedded') || list[0] || null
}
// clé stable d'une piste, indépendante de l'id (régénéré au re-sondage) : index de flux
// pour l'embarqué, chemin pour un fichier importé — sert à restaurer la piste active
function audioTrackKey(tr) {
  if (!tr) return null
  return tr.type === 'embedded' ? `emb:${tr.index}` : `file:${tr.path || tr.label || ''}`
}
// s'assure qu'une piste active valide est choisie ; si l'id a disparu (régénéré au
// re-sondage), on restaure par clé stable (index embarqué / chemin), sinon 1re piste
function ensureActiveAudio() {
  if (!audioById(project.activeAudioId)) {
    const all = project.audioTracks || []
    const byKey = project.activeAudioKey ? all.find((a) => audioTrackKey(a) === project.activeAudioKey) : null
    project.activeAudioId = (byKey || all.find((a) => a.type === 'embedded') || all[0] || {}).id || null
  }
  project.activeAudioKey = audioTrackKey(audioById(project.activeAudioId))
}
function setActiveAudio(id) {
  if (project.activeAudioId === id) return
  project.activeAudioId = id
  project.activeAudioKey = audioTrackKey(audioById(id)) // clé stable pour la réouverture
  renderTrackHeads()
  markDirty()
  buildWaveform() // la bande rythmo affiche la forme d'onde de la piste active
}

function embeddedTrackLabel(p) {
  return t('trackAudioName', p.index + 1) + (p.lang ? ` (${p.lang})` : '')
}

// (re)synchronise les pistes embarquées avec le sondage ffmpeg (offset conservé par
// index), garde les pistes importées, choisit une piste active par défaut.
async function probeAndSyncAudio() {
  if (DETACHED || !project.videoPath) return
  const probed = (await window.api.probeAudioTracks(project.videoPath)) || []
  const externals = (project.audioTracks || []).filter((tr) => tr.type === 'file')
  const prev = new Map((project.audioTracks || []).filter((tr) => tr.type === 'embedded').map((tr) => [tr.index, tr]))
  const embedded = probed.map((p) => {
    const old = prev.get(p.index)
    return {
      id: old?.id || uid(), type: 'embedded', index: p.index,
      lang: p.lang, codec: p.codec, channels: p.channels,
      label: old?.label || embeddedTrackLabel(p), offset: old?.offset || 0,
    }
  })
  project.audioTracks = [...embedded, ...externals]
  ensureActiveAudio()
  if (activeTab === 'tracks') renderTracks()
  // (re)construit la forme d'onde MAINTENANT que les pistes sont connues : buildWaveform()
  // est appelé au chargement AVANT ce sondage (audioTracks encore vide), ce qui le faisait
  // retomber sur le conteneur .mkv brut → decodeAudioData qui dérive. Ici la piste active
  // est une vraie piste embarquée → extraction ffmpeg propre, calée sur la lecture.
  buildWaveform()
}

// renderTracks = en-têtes (gauche) + (re)dimensionnement du canvas timeline
function renderTracks() {
  const noVideo = !project.videoPath
  $('tracksEmpty').classList.toggle('hidden', !noVideo) // placeholder propre quand pas de vidéo
  $('tracksWrap').classList.toggle('hidden', noVideo)
  $('btnDub').classList.toggle('hidden', !dubVoicelessTrack()) // « Doublage » visible si piste sans-voix
  renderTrackHeads()
  resizeTracksCanvas()
}

// ---------- en-têtes de pistes (colonne de gauche, façon NLE) ----------
function renderTrackHeads() {
  const wrap = $('trackHeads')
  wrap.innerHTML = ''
  const spacer = document.createElement('div')
  spacer.className = 'trk-head-spacer'
  wrap.appendChild(spacer)
  if (!project.videoPath) return
  for (const tr of trackLanes()) {
    const row = document.createElement('div')
    row.className = 'trk-head' + (tr.kind === 'video' ? ' video' : '') + (tr.id === selectedTrackId ? ' selected' : '')
    row.style.height = TRK_LANE_H + 'px'
    row.dataset.id = tr.id
    if (tr.kind === 'video') {
      const ic = document.createElement('span'); ic.className = 'trk-ic'; ic.textContent = '🎞'
      const nm = document.createElement('span'); nm.className = 'trk-hname'; nm.textContent = t('trackVideoName')
      row.append(ic, nm)
    } else {
      const on = tr.id === project.activeAudioId
      const spk = document.createElement('button')
      spk.className = 'trk-spk' + (on ? ' on' : '')
      spk.innerHTML = on ? SPK_ON_SVG : SPK_OFF_SVG
      spk.title = t('trackActiveTitle')
      spk.addEventListener('click', (e) => { e.stopPropagation(); setActiveAudio(tr.id) })
      const nm = document.createElement('span'); nm.className = 'trk-hname'; nm.textContent = tr.label || baseName(tr.path)
      const meta = document.createElement('span'); meta.className = 'trk-hmeta'
      const base = tr.type === 'file' ? t('trackExternal') : `${tr.codec || ''} ${trackChannels(tr.channels)}`.trim()
      meta.textContent = base + (tr.voiceless ? ' · ' + t('dubVoiceless') : '')
      const txt = document.createElement('span'); txt.className = 'trk-htxt'; txt.append(nm, meta)
      row.append(spk)
      // marqueur « piste voix » : visible seulement s'il existe une piste sans-voix, et pas sur elle
      if (dubVoicelessTrack() && !tr.voiceless) {
        const vb = document.createElement('button')
        const isVoice = (dubVoiceTrack() || {}).id === tr.id
        vb.className = 'trk-voice' + (isVoice ? ' on' : '')
        vb.innerHTML = VOICE_SVG; vb.title = t('dubVoiceMark')
        vb.addEventListener('click', (e) => { e.stopPropagation(); project.voiceTrackId = tr.id; markDirty(); renderTrackHeads(); syncPlaybackAudio() })
        row.append(vb)
      }
      row.append(txt)
      if (tr.type === 'file') {
        const del = document.createElement('button')
        del.className = 'trk-del'; del.innerHTML = TRASH_SVG; del.title = t('trackDelete')
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteTrack(tr.id) })
        row.appendChild(del)
      }
    }
    row.addEventListener('click', () => { selectedTrackId = tr.id; renderTrackHeads() })
    wrap.appendChild(row)
  }
}

function deleteTrack(id) {
  const tr = audioById(id)
  if (!tr || tr.type !== 'file') return // seules les pistes importées se suppriment
  pushUndo()
  const wasActive = project.activeAudioId === id
  const wasDubRelated = tr.voiceless || project.voiceTrackId === id
  project.audioTracks = project.audioTracks.filter((k) => k.id !== id)
  if (selectedTrackId === id) selectedTrackId = null
  if (project.voiceTrackId === id) project.voiceTrackId = null
  if (wasActive) { project.activeAudioId = (activeAudioTrack() || {}).id || null; buildWaveform() }
  if (wasDubRelated) { $('dubPop').classList.add('hidden'); syncPlaybackAudio() }
  renderTracks(); markDirty()
}

// ---------- monitoring doublage : popover « voix par personnage » ----------
const isDubMuted = (id) => (project.muteChars || []).includes(id)
function setDubMuted(id, muted) {
  project.muteChars = (project.muteChars || []).filter((c) => c !== id)
  if (muted) project.muteChars.push(id)
  markDirty(); syncPlaybackAudio() // (re)active ou coupe le mode monitoring
}
function buildDubPop() {
  const pop = $('dubPop'); pop.innerHTML = ''
  const chars = project.characters || []
  if (!chars.length) { const e = document.createElement('div'); e.className = 'dub-pop-empty'; e.textContent = t('dubNoChars'); pop.appendChild(e); return }
  for (const c of chars) {
    const row = document.createElement('label'); row.className = 'dub-row'
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !isDubMuted(c.id)
    cb.addEventListener('change', () => setDubMuted(c.id, !cb.checked))
    const dot = document.createElement('span'); dot.className = 'dub-dot'; dot.style.background = c.color || '#888'
    const nm = document.createElement('span'); nm.className = 'dub-name'; nm.textContent = c.name || '—'
    row.append(cb, dot, nm); pop.appendChild(row)
  }
}
function toggleDubPop() {
  const pop = $('dubPop')
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return }
  buildDubPop()
  const r = $('btnDub').getBoundingClientRect()
  pop.style.left = Math.round(r.left) + 'px'
  pop.style.top = Math.round(r.bottom + 4) + 'px'
  pop.classList.remove('hidden')
}
$('btnDub').addEventListener('click', (e) => { e.stopPropagation(); toggleDubPop() })
document.addEventListener('click', (e) => {
  const p = $('dubPop')
  if (!p.classList.contains('hidden') && !p.contains(e.target) && e.target !== $('btnDub')) p.classList.add('hidden')
})

// ---------- canvas timeline (même zoom/défilement/curseur que la bande) ----------
function resizeTracksCanvas() {
  // canvas = hauteur de CONTENU (stable). L'espace vide sous la dernière piste est couvert par
  // le fond de #tracksCanvasWrap, et la ligne de lecture est un overlay DOM pleine hauteur
  // (#tracksPlayhead) — pas de mise à l'échelle du canvas sur le viewport, donc aucune boucle
  // de rétroaction avec le ResizeObserver / la scrollbar.
  const h = RULER_H + trackLanes().length * TRK_LANE_H
  tcanvas.style.height = h + 'px'
  const r = tcanvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  tcw = r.width; tch = h
  // n'assigner width/height (qui EFFACE le canvas) que si les pixels changent vraiment :
  // un resize vertical ne change ni la largeur ni la hauteur de contenu → pas de clignotement
  const pw = Math.round(tcw * dpr), ph = Math.round(h * dpr)
  if (tcanvas.width !== pw || tcanvas.height !== ph) {
    tcanvas.width = pw
    tcanvas.height = ph
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}
new ResizeObserver(() => { if (activeTab === 'tracks') resizeTracksCanvas() }).observe($('tracksCanvasWrap'))

// ---------- timeline « pleine largeur » : toute la vidéo tient dans la largeur, sans zoom ----------
const TRK_MARGIN = 30 // marge gauche/droite (px) : marque début/fin et laisse offsetter au drag
const tDurTracks = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : 0)
const tUsable = () => Math.max(1, tcw - 2 * TRK_MARGIN)
const tPpsFit = () => { const d = tDurTracks(); return d > 0 ? tUsable() / d : 0 }
const tXAt = (tt) => TRK_MARGIN + tt * tPpsFit()
const tTimeAt = (x) => { const p = tPpsFit(); return p > 0 ? clamp((x - TRK_MARGIN) / p, 0, tDurTracks()) : 0 }
// pas de règle « joli » pour ~une graduation tous les ~100 px
function niceTimeStep(total) {
  const target = total / Math.max(3, Math.floor(tUsable() / 100))
  return [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => s >= target) || 3600
}
const fmtMS = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`

// overlay « carte des répliques » sur la piste vidéo : phrases empilées par piste rythmo,
// colorées par personnage (comme la barre de progression, mais sur plusieurs niveaux)
function drawVideoLane(y, x0v, x1v) {
  const cy = y + 4, chh = TRK_LANE_H - 8
  tctx.fillStyle = '#6cbf6a22'; tctx.strokeStyle = '#6cbf6acc'
  tctx.beginPath(); tctx.roundRect(x0v, cy, Math.max(6, x1v - x0v), chh, 5); tctx.fill(); tctx.stroke()
  const nT = Math.max(1, project.tracks || 1)
  const lvlH = chh / nT
  for (const l of project.lines) {
    if (!l.words || !l.words.length) continue
    const lx0 = tXAt(lineStart(l))
    const lx1 = tXAt(lineEnd(l))
    const lvl = clamp(l.track || 0, 0, nT - 1)
    const ly = cy + lvl * lvlH + 1
    tctx.fillStyle = getChar(l.characterId)?.color || '#888'
    tctx.beginPath(); tctx.roundRect(lx0, ly, Math.max(1.5, lx1 - lx0), Math.max(2, lvlH - 2), 2); tctx.fill()
  }
}

function drawTracks() {
  if (!tcw) { resizeTracksCanvas(); if (!tcw) return }
  const pal = bandPal()
  if (!project.videoPath) { tctx.fillStyle = pal.bg; tctx.fillRect(0, 0, tcw, tch); return }
  const now = effectiveTime()
  const dur = tDurTracks()
  const lanes = trackLanes()
  const x0v = tXAt(0), x1v = tXAt(dur)

  tctx.fillStyle = pal.bg; tctx.fillRect(0, 0, tcw, tch)

  // règle (mm:ss) : graduations réparties sur toute la largeur
  tctx.fillStyle = pal.rulerBg; tctx.fillRect(0, 0, tcw, RULER_H)
  tctx.font = '12px Consolas, monospace'; tctx.textBaseline = 'middle'
  if (dur > 0) {
    const step = niceTimeStep(dur)
    tctx.textAlign = 'left'
    for (let s = 0; s < dur - step * 0.5; s += step) {
      const x = tXAt(s)
      tctx.strokeStyle = pal.tick; tctx.beginPath(); tctx.moveTo(x + 0.5, RULER_H - 8); tctx.lineTo(x + 0.5, RULER_H); tctx.stroke()
      tctx.fillStyle = pal.tickText; tctx.fillText(fmtMS(s), x + 3, RULER_H / 2)
    }
    // fin de vidéo : graduation + label calés à droite
    tctx.strokeStyle = pal.tick; tctx.beginPath(); tctx.moveTo(x1v + 0.5, RULER_H - 8); tctx.lineTo(x1v + 0.5, RULER_H); tctx.stroke()
    tctx.fillStyle = pal.tickText; tctx.textAlign = 'right'; tctx.fillText(fmtMS(dur), x1v - 3, RULER_H / 2)
    tctx.textAlign = 'left'
  }

  lanes.forEach((tr, i) => {
    const y = RULER_H + i * TRK_LANE_H
    if (i % 2 === 1) { tctx.fillStyle = pal.lane; tctx.fillRect(0, y, tcw, TRK_LANE_H) }
    if (tr.id === selectedTrackId) { tctx.fillStyle = pal.handleAccent + '22'; tctx.fillRect(0, y, tcw, TRK_LANE_H) }
    tctx.strokeStyle = pal.grid; tctx.beginPath(); tctx.moveTo(0, y + 0.5); tctx.lineTo(tcw, y + 0.5); tctx.stroke()

    if (tr.kind === 'video') { drawVideoLane(y, x0v, x1v); return }

    // piste audio : clip positionné par offset, glissable librement
    const isActive = tr.id === project.activeAudioId
    const off = tr.offset || 0
    const cx0 = tXAt(off)
    const cx1 = tXAt(off + (dur || 0))
    const cy = y + 5, chh = TRK_LANE_H - 10
    const col = isActive ? pal.handleAccent : pal.tickText
    tctx.fillStyle = col + '2e'
    tctx.strokeStyle = col + (isActive ? 'cc' : '66')
    tctx.lineWidth = isActive ? 1.8 : 1
    tctx.beginPath(); tctx.roundRect(cx0, cy, Math.max(6, cx1 - cx0), chh, 5)
    tctx.fill(); tctx.stroke(); tctx.lineWidth = 1

    // forme d'onde de la piste active (calée sur le clip via son offset)
    if (isActive && wave) {
      const midY = cy + chh / 2, amp = chh / 2 - 4
      const pps = tPpsFit() || 1
      const xa = Math.max(0, cx0), xb = Math.min(tcw, cx1)
      tctx.fillStyle = col + '66'; tctx.beginPath(); tctx.moveTo(xa, midY)
      for (let x = xa; x <= xb; x++) { const tt = (x - cx0) / pps; let v = 0; if (tt >= 0 && tt < wave.duration) { const b = (tt * wave.perSec) | 0; if (b < wave.peaks.length) v = wave.peaks[b] } tctx.lineTo(x, midY - v * amp) }
      for (let x = xb; x >= xa; x--) { const tt = (x - cx0) / pps; let v = 0; if (tt >= 0 && tt < wave.duration) { const b = (tt * wave.perSec) | 0; if (b < wave.peaks.length) v = wave.peaks[b] } tctx.lineTo(x, midY + v * amp) }
      tctx.closePath(); tctx.fill()
    }

    tctx.fillStyle = pal.tickText; tctx.font = '11px "Segoe UI", sans-serif'; tctx.textBaseline = 'middle'
    tctx.fillText(tr.label || baseName(tr.path), Math.max(4, cx0 + 7), cy + 9)
  })

  // repères début / fin de vidéo : lignes verticales pleine hauteur bien visibles
  tctx.strokeStyle = pal.handleAccent + 'dd'; tctx.lineWidth = 1.5
  for (const bx of [x0v, x1v]) { tctx.beginPath(); tctx.moveTo(bx + 0.5, RULER_H); tctx.lineTo(bx + 0.5, tch); tctx.stroke() }
  tctx.lineWidth = 1

  // ligne de lecture : overlay DOM pleine hauteur, positionné ici (le canvas ne défile plus)
  const phx = tXAt(now)
  $('tracksPlayhead').style.left = phx + 'px'
  // flèche rouge en tête de la ligne de lecture (comme l'onglet rythmo)
  const aw = 5
  tctx.fillStyle = pal.playhead
  tctx.beginPath(); tctx.moveTo(phx - aw, 0); tctx.lineTo(phx + aw, 0); tctx.lineTo(phx, aw * 1.7); tctx.closePath(); tctx.fill()
}

// ---------- interactions souris : clic/glisser = seek (position absolue), glisser piste = offset ----------
let tdrag = null
const tLaneAt = (y) => (y < RULER_H ? -1 : Math.floor((y - RULER_H) / TRK_LANE_H))

tcanvas.addEventListener('pointerdown', (e) => {
  const r = tcanvas.getBoundingClientRect()
  const x = e.clientX - r.left, y = e.clientY - r.top
  tcanvas.setPointerCapture(e.pointerId)
  const li = tLaneAt(y)
  const tr = li >= 0 ? trackLanes()[li] : null
  if (tr) { selectedTrackId = tr.id; renderTrackHeads() }
  if (li >= 0 && tr && tr.kind !== 'video') {
    tdrag = { kind: 'offset', tr, x0: x, startOff: tr.offset || 0, pushed: false }
  } else {
    video.pause(); scrub.active = true
    tdrag = { kind: 'scrub' }
    scrubTo(tTimeAt(x)); playScrubGrain(scrub.time)
    tcanvas.style.cursor = 'grabbing'
  }
})
tcanvas.addEventListener('pointermove', (e) => {
  const r = tcanvas.getBoundingClientRect()
  const x = e.clientX - r.left
  if (!tdrag) { tcanvas.style.cursor = tLaneAt(e.clientY - r.top) >= 1 ? 'ew-resize' : 'grab'; return }
  if (tdrag.kind === 'scrub') {
    scrubTo(tTimeAt(x)); playScrubGrain(scrub.time)
  } else if (tdrag.kind === 'offset') {
    if (!tdrag.pushed) { pushUndo(); tdrag.pushed = true }
    const pps = tPpsFit() || 1
    let off = tdrag.startOff + (x - tdrag.x0) / pps
    if (Math.abs(off) < 6 / pps) off = 0 // aimant sur l'origine
    tdrag.tr.offset = off
    if (tdrag.tr.id === project.activeAudioId) { waveOffset = off; playAOffset = off }
    markDirty()
  }
})
function tEndDrag() {
  // fin d'un glisser d'offset sur la piste active → la lecture doit suivre le décalage
  if (tdrag && tdrag.kind === 'offset' && tdrag.tr.id === project.activeAudioId) syncPlaybackAudio()
  tdrag = null; scrub.active = false
  if (!scrub.busy && scrub.pending == null) scrub.time = null
  tcanvas.style.cursor = 'grab'
}
tcanvas.addEventListener('pointerup', tEndDrag)
tcanvas.addEventListener('pointercancel', tEndDrag)
tcanvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  video.pause()
  const pps = tPpsFit() || 1
  scrubTo(clamp(effectiveTime() + (e.deltaY || e.deltaX) / pps * 0.5, 0, tDurTracks()))
  playScrubGrain(scrub.time)
}, { passive: false })

// ---------- import d'un fichier audio externe ----------
async function addExternalAudio(p, label, flags) {
  if (!project.videoPath) { toast(t('loadVideoFirst')); return }
  if (!p) return
  pushUndo()
  const tr = { id: uid(), type: 'file', path: p, label: label || baseName(p), offset: 0, channels: 0, ...(flags || {}) }
  project.audioTracks.push(tr)
  if (activeTab !== 'tracks') setTab('tracks')
  else renderTracks()
  markDirty()
  toast(t('audioImported', baseName(p)))
  // sonde le nombre de canaux réel (asynchrone) puis rafraîchit l'en-tête, si la piste
  // est toujours présente (l'utilisateur a pu la retirer entre-temps)
  try {
    const probed = await window.api.probeAudioTracks(p)
    if (probed && probed[0] && (project.audioTracks || []).includes(tr)) {
      tr.channels = probed[0].channels
      if (activeTab === 'tracks') renderTrackHeads()
    }
  } catch {}
}
$('btnImportAudio').addEventListener('click', async () => {
  const p = await window.api.openAudio()
  if (p) addExternalAudio(p)
})

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

window.api.onProxyProgress((pct) => {
  if (proxyActive) showProxyStatus(t('proxyGenerating', pct))
})

video.addEventListener('loadedmetadata', () => {
  // le proxy partage durée/cadence avec la source : on conserve les infos de la source
  // (résolution, taille, nom) et on ne re-sonde ni le fps ni les pistes audio
  if (usingProxy) return
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
let wave = null // { peaks: Float32Array, perSec, duration } — forme d'onde de la piste active
let videoRmsDb = null // niveau moyen (dBFS) de la piste active — référence d'équilibrage de la chaîne voix
let waveOffset = 0 // décalage (s) de la piste active, appliqué à l'affichage de la forme d'onde
let showWave = true
let waveToken = 0
let scrubCtx = null
let scrubBuf = null // audio mono décodé, pour entendre le son pendant le scrub

async function buildWaveform() {
  if (DETACHED) return // pas de forme d'onde dans la fenêtre de rendu
  wave = null
  scrubBuf = null
  const token = ++waveToken
  syncPlaybackAudio() // la lecture suit aussi la piste active
  // forme d'onde de la piste active : fichier externe → le fichier ; piste embarquée
  // (index 0 compris) → extraite en WAV 16 kHz par ffmpeg ; sinon la vidéo.
  const a = (typeof activeAudioTrack === 'function' && activeAudioTrack()) || null
  waveOffset = (a && a.offset) || 0
  let src = null
  let isVideoDefault = false
  if (a && a.type === 'file') {
    src = a.path
  } else if (a && a.type === 'embedded') {
    // Toute piste embarquée passe par l'extraction ffmpeg — on ne feed JAMAIS le
    // conteneur .mkv brut à decodeAudioData : sur certains fichiers (audio 48 kHz),
    // son rééchantillonnage interne 48→16 kHz DÉRIVE (audio compressé de ~0,35 %,
    // soit plusieurs secondes d'avance en fin de vidéo ; forme d'onde et scrub
    // décalés de la lecture). Le WAV 16 kHz d'ffmpeg conserve la durée exacte.
    src = await window.api.extractAudioTrack(project.videoPath, a.index)
    if (token !== waveToken) return
    // panneau info : nb de canaux réels de la piste par défaut via le sondage
    // (l'extraction est mono, donc audio.numberOfChannels ne le reflète pas)
    if (a.index === 0 && a.channels) {
      videoInfo = Object.assign(videoInfo || {}, { channels: a.channels })
      updateVideoInfoPanel()
    }
  } else {
    src = project.videoPath
    isVideoDefault = true
  }
  if (!src) return
  try {
    const buf = await window.api.readFile(src)
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
    // niveau moyen absolu (avant normalisation des peaks) : cible de la chaîne voix
    { let sq = 0, ns = 0; const d0 = audio.getChannelData(0); for (let i = 0; i < d0.length; i += 4) { sq += d0[i] * d0[i]; ns++ }; videoRmsDb = ns ? 10 * Math.log10(sq / ns + 1e-12) : null }
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
    // l'info « Audio » du panneau reflète la piste embarquée par défaut de la vidéo,
    // pas une piste active externe/extraite (mono)
    if (isVideoDefault) {
      videoInfo = Object.assign(videoInfo || {}, { channels: audio.numberOfChannels })
      updateVideoInfoPanel()
    }
  } catch {
    if (token === waveToken) toast(t('waveFail'))
  }
}

// ---------- lecture de la piste active ----------
// La vidéo (source ou proxy) ne peut jouer que sa 1re piste audio : pour toute autre
// piste active (embarquée > 0, fichier externe, ou décalage non nul), un <audio> caché
// synchronisé sur la vidéo porte le son et la vidéo est réduite au silence.
let playA = null // élément <audio> de la piste active
let playAUrl = null // URL en cours, pour ne pas recharger inutilement
let playAToken = 0
let playAActive = false // le son passe par playA (sinon : audio natif de la vidéo)
let playAOffset = 0 // décalage (s) de la piste active, appliqué à la position de lecture

function applyVolume() {
  if (DETACHED) { video.volume = 0; video.muted = true; return } // le son sort de la fenêtre principale
  const vol = Number($('volume').value)
  if (dub.on) { // monitoring doublage : le son passe par le mix WebAudio
    video.volume = 0
    if (dub.master) dub.master.gain.value = video.muted ? 0 : vol
    return
  }
  video.volume = playAActive ? 0 : vol
  if (playA) { playA.volume = vol; playA.muted = video.muted }
}

// re-cale playA sur la vidéo (hard = seek exigé, sinon seuil de dérive)
function syncPlayAPosition(hard) {
  if (!playAActive || !playA || !playAUrl) return
  const tt = video.currentTime - playAOffset
  const inRange = tt >= 0 && tt < (playA.duration || Infinity)
  if (video.paused || !inRange) {
    if (!playA.paused) playA.pause()
    if (hard && inRange) { try { playA.currentTime = tt } catch {} }
    return
  }
  if (Math.abs(playA.currentTime - tt) > (hard ? 0.05 : 0.3)) { try { playA.currentTime = tt } catch {} }
  playA.playbackRate = video.playbackRate
  if (playA.paused) playA.play().catch(() => {})
}

// choisit la source de playA selon la piste active (mêmes règles que buildWaveform)
async function syncPlaybackAudio() {
  if (DETACHED) { applyVolume(); return }
  const token = ++playAToken
  // mode monitoring doublage : mix V / sans-voix (prioritaire sur le chemin mono-piste)
  if (dubEnabled()) {
    playAActive = false
    if (playA) { try { playA.pause() } catch {} }
    await dubBuild()
    return
  }
  dubTeardown() // hors mode doublage : coupe le mix et annule tout build en vol (token++)
  const a = (typeof activeAudioTrack === 'function' && activeAudioTrack()) || null
  playAOffset = (a && a.offset) || 0
  // piste par défaut de la vidéo sans décalage → l'audio natif de la vidéo suffit
  const needsAux = !!a && (a.type === 'file' || a.index > 0 || playAOffset !== 0)
  if (!needsAux) {
    playAActive = false
    playAUrl = null
    if (playA) { playA.pause(); playA.removeAttribute('src'); playA.load() }
    applyVolume()
    return
  }
  let src = null
  if (a.type === 'file') src = a.path
  else src = await window.api.extractAudioPlay(project.videoPath, a.index)
  if (token !== playAToken) return
  if (!src) { playAActive = false; playAUrl = null; applyVolume(); return } // repli : audio natif
  const url = await window.api.fileUrl(src)
  if (!url || token !== playAToken) return
  playA ||= new Audio()
  playA.preload = 'auto'
  if (playAUrl !== url) { playAUrl = url; playA.src = url }
  playAActive = true
  applyVolume()
  syncPlayAPosition(true)
}

video.addEventListener('play', () => { syncPlayAPosition(true); if (dub.on) dubSync(true) })
video.addEventListener('pause', () => { if (playA && !playA.paused) playA.pause(); if (dub.on) dubSync(true) })
video.addEventListener('seeked', () => { syncPlayAPosition(true); if (dub.on) dubSync(true) })
video.addEventListener('ratechange', () => { if (playA) playA.playbackRate = video.playbackRate; if (dub.on) dubSync(true) })
video.addEventListener('timeupdate', () => { syncPlayAPosition(false); if (dub.on) dubSync(false) })
video.addEventListener('volumechange', applyVolume)

// ============================================================ monitoring doublage
// Quand une piste « sans voix » existe et qu'au moins un personnage est décoché, la lecture
// mixe deux sources synchronisées : la piste VOIX (V) et la piste SANS-VOIX (VL), via WebAudio.
// Pendant une réplique d'un perso décoché → fondu ~30 ms vers VL (voix retirée) ; sinon → V.
// Le fond sonore étant commun aux deux pistes, le fondu ne crée aucune perte de volume.
const dub = { ctx: null, v: null, vl: null, srcV: null, srcVL: null, gV: null, gVL: null, master: null, on: false, vUrl: null, vlUrl: null, vOff: 0, vlOff: 0, token: 0 }
const dubVoicelessTrack = () => (project.audioTracks || []).find((a) => a.voiceless) || null
function dubVoiceTrack() {
  const tagged = audioById(project.voiceTrackId)
  if (tagged && !tagged.voiceless) return tagged
  const act = audioById(project.activeAudioId)
  if (act && !act.voiceless) return act
  const cand = (project.audioTracks || []).filter((a) => !a.voiceless)
  return cand.find((a) => a.type === 'embedded') || cand[0] || null
}
const dubEnabled = () => !!project.videoPath && !!dubVoicelessTrack() && (project.muteChars || []).length > 0 && !!dubVoiceTrack()

async function dubTrackUrl(tr) {
  if (!tr) return null
  const src = tr.type === 'file' ? tr.path : await window.api.extractAudioPlay(project.videoPath, tr.index)
  return src ? await window.api.fileUrl(src) : null
}
async function dubBuild() {
  const token = ++dub.token
  const V = dubVoiceTrack(), VL = dubVoicelessTrack()
  const [vUrl, vlUrl] = await Promise.all([dubTrackUrl(V), dubTrackUrl(VL)])
  if (token !== dub.token) return
  if (!vUrl || !vlUrl) { dubTeardown(); applyVolume(); return }
  const AC = window.AudioContext || window.webkitAudioContext
  dub.ctx ||= new AC()
  dub.v ||= new Audio(); dub.vl ||= new Audio()
  dub.v.preload = 'auto'; dub.vl.preload = 'auto'
  if (dub.vUrl !== vUrl) { dub.vUrl = vUrl; dub.v.src = vUrl }
  if (dub.vlUrl !== vlUrl) { dub.vlUrl = vlUrl; dub.vl.src = vlUrl }
  dub.vOff = (V && V.offset) || 0
  dub.vlOff = (VL && VL.offset) || 0
  if (!dub.srcV) { dub.srcV = dub.ctx.createMediaElementSource(dub.v); dub.gV = dub.ctx.createGain(); dub.srcV.connect(dub.gV) }
  if (!dub.srcVL) { dub.srcVL = dub.ctx.createMediaElementSource(dub.vl); dub.gVL = dub.ctx.createGain(); dub.srcVL.connect(dub.gVL) }
  if (!dub.master) { dub.master = dub.ctx.createGain(); dub.gV.connect(dub.master); dub.gVL.connect(dub.master); dub.master.connect(dub.ctx.destination) }
  dub.gV.gain.value = 1; dub.gVL.gain.value = 0
  dub.on = true
  applyVolume()
  dubSync(true)
}
function dubTeardown() {
  dub.token++
  dub.on = false
  try { if (dub.v) dub.v.pause() } catch {}
  try { if (dub.vl) dub.vl.pause() } catch {}
  if (dub.master) dub.master.gain.value = 0
}
// une réplique d'un perso décoché est-elle active à l'instant t ?
function dubWantVL(tt) {
  const mset = project.muteChars || []
  if (!mset.length) return false
  for (const l of project.lines) {
    if (!l.words || !l.words.length || !mset.includes(l.characterId)) continue
    if (tt >= lineStart(l) && tt < lineEnd(l)) return true
  }
  return false
}
function dubSyncPos(el, off, hard) {
  const tt = video.currentTime - off
  const inRange = tt >= 0 && tt < (el.duration || Infinity)
  if (video.paused || !inRange) { if (!el.paused) el.pause(); if (hard && inRange) { try { el.currentTime = tt } catch {} } return }
  if (Math.abs(el.currentTime - tt) > (hard ? 0.05 : 0.3)) { try { el.currentTime = tt } catch {} }
  el.playbackRate = video.playbackRate
  if (el.paused) el.play().catch(() => {})
}
function dubSync(hard) {
  if (!dub.on || !dub.ctx) return
  if (dub.ctx.state === 'suspended') dub.ctx.resume().catch(() => {})
  dubSyncPos(dub.v, dub.vOff, hard)
  dubSyncPos(dub.vl, dub.vlOff, hard)
  const wantVL = dubWantVL(video.currentTime)
  const now = dub.ctx.currentTime
  dub.gV.gain.setTargetAtTime(wantVL ? 0 : 1, now, 0.012) // fondu ~30 ms
  dub.gVL.gain.setTargetAtTime(wantVL ? 1 : 0, now, 0.012)
}

// ============================================================ canvas rendering
let cw = 0, ch = 0 // CSS pixels

function resizeCanvas() {
  const r = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  cw = r.width
  ch = r.height
  // même garde que pour les pistes : ne réinitialiser le canvas (effacement) que si ses
  // dimensions en pixels changent réellement, pour éviter tout clignotement au resize
  const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
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
  // opts.trackList : sous-ensemble de pistes à montrer, compacté en lanes contiguës
  // (export d'une sélection de pistes) ; sinon toutes les pistes affichées.
  const list = opts.trackList && opts.trackList.length ? opts.trackList : null
  const N = list ? list.length : laneCount()
  const rowOf = (tr) => (list ? list.indexOf(tr) : tr)
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
      const t = tAt(x) - waveOffset // décalage de la piste active
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

  // répliques (opts.lines : liste alternative, ex. onglet Enregistrement — répliques
  // du perso sélectionné écrasées sur une piste unique)
  for (const line of (opts.lines || project.lines)) {
    const row = rowOf(line.track)
    if (row < 0) continue // piste exclue de la sélection d'export
    const s = lineStart(line)
    const e = lineEnd(line)
    const x0 = xAt(s)
    const x1 = xAt(e)
    if (x1 < -50 || x0 > W + 50) continue

    const char = getChar(line.characterId)
    const color = char ? char.color : '#888888'
    const y = rh + row * th
    const selected = opts.handles && selectedIds.has(line.id)

    // fond coloré du bloc de réplique : uniquement dans l'éditeur (opts.blocks).
    // À l'export, dans la preview d'export et en mode lecture plein écran, on ne
    // veut que le texte, sans rectangle de fond.
    if (opts.blocks) {
      c.fillStyle = color + '22'
      c.beginPath()
      c.roundRect(x0, y + 3, Math.max(4, x1 - x0), th - 6, 5)
      c.fill()
    }
    if (selected) {
      c.beginPath() // retrace le bloc (le fond peut être masqué) pour le contour
      c.roundRect(x0, y + 3, Math.max(4, x1 - x0), th - 6, 5)
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

    // badge du personnage à gauche du bloc : fond = couleur du perso, nom en texte
    // lisible (blanc, ou noir sur couleur claire)
    const nm = char ? char.name : '?'
    const nameFont = Math.max(9, Math.round(th * 0.18))
    c.font = `bold ${nameFont}px "Segoe UI", sans-serif`
    const padX = 5
    const tagH = nameFont + 5
    const tagW = c.measureText(nm).width + padX * 2
    const tagX = Math.max(0, x0)
    const tagY = y + 2
    c.fillStyle = color
    c.beginPath(); c.roundRect(tagX, tagY, tagW, tagH, 3); c.fill()
    c.fillStyle = textOn(color)
    c.textAlign = 'left'
    c.textBaseline = 'middle'
    c.fillText(nm, tagX + padX, tagY + tagH / 2 + 0.5)

    // mots — élongation : chaque mot est étiré sur sa durée réelle
    const fontPx = Math.round(th * 0.52)
    c.font = `bold ${fontPx}px ${bandFontFamily(line)}`
    c.textBaseline = 'alphabetic'
    for (let wi = 0; wi < line.words.length; wi++) {
      const w = line.words[wi]
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

      // signe de détection posé sur ce mot (articulation à respecter). Contenu
      // de la bande → dessiné aussi à l'export et en mode lecture plein écran.
      if (line.symbols && line.symbols[wi] != null && typeof DET_BY_KEY !== 'undefined') {
        const sym = DET_BY_KEY.get(line.symbols[wi])
        if (sym) {
          c.save()
          c.font = `${Math.max(9, Math.round(th * 0.26))}px "Segoe UI", sans-serif`
          c.textAlign = 'center'
          c.textBaseline = 'middle'
          const sx = wx + Math.max(5, ww / 2)
          const sy = y + th * 0.27
          c.lineWidth = Math.max(2, th * 0.03)
          c.strokeStyle = pal.bg
          c.strokeText(sym.glyph, sx, sy)
          c.fillStyle = pal.symbol || '#ffd24a'
          c.fillText(sym.glyph, sx, sy)
          c.restore()
        }
      }
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
          const stretch = hov && !hoverEdge.ctrl

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

          // sans Ctrl : chevrons « proportionnel » (extrémité = toute la réplique,
          // frontière interne = le texte du côté opposé se compresse / s'étend)
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
  renderBand(ctx, effectiveTime(), cw, ch, pxPerSec, { ruler: true, wave: showWave, handles: true, blocks: true, theme: bandPal() })
  drawLoops()
  drawPlans()
  drawCuesTimeline()
  drawHoverCursor()
  drawDragGuide()
  updateSubOverlay()
}

// sous-titre « classique » superposé à l'aperçu vidéo (éditeur uniquement) :
// « Personnage : phrase » au bon timing, fond noir, texte blanc, nom du
// personnage en blanc avec un contour de la couleur du personnage. Les
// répliques actives simultanées (plusieurs pistes) sont empilées par piste.
let lastSubKey = null
function hideSubOverlay() {
  const el = $('subOverlay')
  if (el && lastSubKey !== null) { el.hidden = true; el.textContent = ''; lastSubKey = null }
}
function updateSubOverlay() {
  const el = $('subOverlay')
  if (!el) return
  if (!showSubs) { hideSubOverlay(); return }
  const now = effectiveTime()
  const active = project.lines
    .filter((l) => l.words.length && lineStart(l) <= now && now < lineEnd(l))
    .map((l) => {
      const c = getChar(l.characterId)
      return {
        track: l.track || 0,
        name: c ? c.name : '?',
        color: c ? c.color : '#ffffff',
        // les « _ » sont des mots vides (silences) : on ne les affiche pas
        text: l.words.map((w) => w.text).filter((w) => w !== '_').join(' '),
      }
    })
    .filter((s) => s.text.trim())
    .sort((a, b) => a.track - b.track)
  if (!active.length) { hideSubOverlay(); return }
  // ne re-rend le DOM que lorsque le contenu affiché change (loop ~60 fps)
  const key = active.map((s) => `${s.track}|${s.name}|${s.color}|${s.text}`).join('\n')
  if (lastSubKey === key) return
  lastSubKey = key
  el.textContent = ''
  for (const s of active) {
    const lineEl = document.createElement('div')
    lineEl.className = 'sub-line'
    lineEl.style.setProperty('--sub-col', s.color)
    const nameEl = document.createElement('span')
    nameEl.className = 'sub-name'
    nameEl.textContent = s.name
    lineEl.appendChild(nameEl)
    lineEl.appendChild(document.createTextNode(` : ${s.text}`))
    el.appendChild(lineEl)
  }
  el.hidden = false
}

// pendant l'ajustement d'une frontière de mot ou l'étirement d'un bord : ligne
// guide bleue sur toute la bande + timecode de la frontière dans la règle
function drawDragGuide() {
  if (!drag) return
  let tt = null
  if (drag.kind === 'edge' || drag.kind === 'squeeze') tt = drag.line.words[drag.wi][drag.type]
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
  const ts = tt - waveOffset // position dans la piste (décalage de la piste active)
  if (!vol || ts < 0 || ts >= scrubBuf.duration) return
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
  src.start(0, ts, dur)
}

// ============================================================ pointer interactions
let drag = null

// ---------- mode aimant : pendant un glisser ou un resize de répliques, les bords
// s'aimantent aux bords des autres répliques et au point de lecture (seuil 8 px à l'écran)
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

// aimante un temps t (bord en cours de resize) sur le point de lecture et les bords
// des autres répliques — même seuil que magnetAdjust (8 px à l'écran)
function magnetSnapTime(t, excludeId) {
  const thresh = 8 / pxPerSec
  let best = null
  const consider = (tt) => {
    const delta = tt - t
    if (Math.abs(delta) <= thresh && (best === null || Math.abs(delta) < Math.abs(best))) best = delta
  }
  consider(effectiveTime())
  for (const l of project.lines) {
    if (l.id === excludeId || !l.words.length) continue
    consider(lineStart(l))
    consider(lineEnd(l))
  }
  return best === null ? t : t + best
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
  selectedCueId = null // toute sélection de réplique/scrub désélectionne un repère ADR
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
    } else if (e.ctrlKey || e.metaKey) {
      // ctrl : ajuste seulement ce mot (la frontière ne décale que le voisin)
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
    } else {
      // frontière interne sans modificateur : le mot s'étire et tout le texte du
      // côté opposé se compresse / s'étend proportionnellement — les bornes de la
      // réplique ne bougent pas
      drag = { kind: 'squeeze', line, wi: hit.wi, type: hit.type, snapshot: line.words.map((wd) => ({ ...wd })) }
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
    // bande / règle vide : d'abord un repère ADR sous le curseur (sélection + drag),
    // sinon scrub / clic-règle
    const cid = hitCueX(x)
    if (cid) {
      selectedCueId = cid
      selectedIds.clear()
      refreshInspector()
      const q = (project.cues || []).find((c) => c.id === cid)
      drag = { kind: 'cue', id: cid, x0: x, t0: q ? q.time : 0, moved: false }
      canvas.style.cursor = 'grabbing'
    } else {
      selectedIds.clear()
      refreshInspector()
      video.pause()
      scrub.active = true
      drag = { kind: 'scrub', x0: x, t0: effectiveTime(), tClick: timeAtX(x, effectiveTime()), fromRuler: y <= RULER_H, moved: false }
      canvas.style.cursor = 'grabbing'
    }
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
    if (hit.kind !== 'edge' && hit.kind !== 'line' && hitCueX(hover.x)) cur = 'ew-resize' // repère ADR déplaçable
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
  } else if (drag.kind === 'cue') {
    if (Math.abs(dx) > 2) drag.moved = true
    if (drag.moved) {
      if (!drag.pushed) { pushUndo(); drag.pushed = true }
      const q = (project.cues || []).find((c) => c.id === drag.id)
      if (q) { q.time = clamp(drag.t0 + dt, 0, videoDur()); markDirty() }
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
    let t = timeAtX(x, effectiveTime())
    if (magnetOn) t = magnetSnapTime(t, drag.line.id)
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
  } else if (drag.kind === 'squeeze') {
    // frontière déplacée librement : les mots du côté opposé sont recalés
    // proportionnellement entre la frontière et la borne (fixe) de la réplique
    if (!drag.pushed) { pushUndo(); drag.pushed = true }
    const { line, snapshot, wi, type } = drag
    let t = timeAtX(x, effectiveTime())
    if (magnetOn) t = magnetSnapTime(t, line.id)
    const MIN = 0.06
    if (type === 'end') {
      const endT = snapshot[snapshot.length - 1].end
      const b0 = snapshot[wi].end
      t = clamp(t, snapshot[wi].start + MIN, endT - MIN * (snapshot.length - 1 - wi))
      const k = (endT - t) / Math.max(0.001, endT - b0)
      line.words[wi].end = t
      for (let j = wi + 1; j < line.words.length; j++) {
        line.words[j].start = endT - (endT - snapshot[j].start) * k
        line.words[j].end = endT - (endT - snapshot[j].end) * k
      }
    } else {
      const startT = snapshot[0].start
      const b0 = snapshot[wi].start
      t = clamp(t, startT + MIN * wi, snapshot[wi].end - MIN)
      const k = (t - startT) / Math.max(0.001, b0 - startT)
      line.words[wi].start = t
      for (let j = 0; j < wi; j++) {
        line.words[j].start = startT + (snapshot[j].start - startT) * k
        line.words[j].end = startT + (snapshot[j].end - startT) * k
      }
    }
    markDirty()
    refreshInspector()
  } else if (drag.kind === 'edge') {
    if (!drag.pushed) { pushUndo(); drag.pushed = true }
    const now = effectiveTime()
    const line = drag.line
    const w = line.words[drag.wi]
    let t = timeAtX(x, now)
    if (magnetOn) t = magnetSnapTime(t, line.id)
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
    addLineAt(t, tr, '…', NEW_LINE_DUR)
    focusNewLineText()
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

// slider de zoom (transport) — échelle logarithmique : gauche = 5 s (dézoom), droite = 1,8 s (zoom)
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
$('volume').addEventListener('input', applyVolume) // vidéo ou piste active (playA)

// ============================================================ barre de progression globale
// Strip fine au-dessus du transport : clic = saut, glisser = scrub (sans mettre en
// pause), survol = timecode + contexte (scène, plan, répliques). Mini-carte dessinée
// à chaque frame par drawSeekBar() (appelée depuis loop()).
const seekBar = $('seekBar')
const seekFill = $('seekFill')
const seekMarks = $('seekMarks')
const seekTip = $('seekTip')
let showSeekBar = true // Affichage → Barre de progression (persisté dans settings.ini)
let seekDrag = false

const seekFrac = (e) => {
  const r = seekBar.getBoundingClientRect()
  return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1)
}
// durée réelle uniquement (videoDur() renvoie 1e9 tant que la vidéo n'est pas chargée)
const seekDur = () => (video.src && isFinite(video.duration) && video.duration > 0 ? video.duration : 0)

function drawSeekBar() {
  if (!showSeekBar) return
  const dur = seekDur()
  const pct = (dur ? clamp(effectiveTime() / dur, 0, 1) : 0) * 100
  seekFill.style.width = pct + '%'
  const dpr = window.devicePixelRatio || 1
  const w = seekBar.clientWidth
  const h = seekBar.clientHeight
  if (!w || !h) return
  if (seekMarks.width !== Math.round(w * dpr) || seekMarks.height !== Math.round(h * dpr)) {
    seekMarks.width = Math.round(w * dpr)
    seekMarks.height = Math.round(h * dpr)
  }
  const c = seekMarks.getContext('2d')
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, w, h)
  if (!dur) return
  const px = (t) => (t / dur) * w
  // scènes : bandeaux bleutés sur la moitié haute
  c.fillStyle = 'rgba(122, 162, 255, 0.45)'
  for (const lp of project.loops) c.fillRect(px(lp.start), 0, Math.max(1, px(lp.end - lp.start)), h * 0.4)
  // répliques : tirets sur la moitié basse, couleur du personnage
  for (const l of project.lines) {
    if (!l.words.length) continue
    const x0 = px(lineStart(l))
    c.fillStyle = getChar(l.characterId)?.color || '#888'
    c.fillRect(x0, h * 0.55, Math.max(1.5, px(lineEnd(l)) - x0), h * 0.45)
  }
  // plans : traits verticaux ambre pleine hauteur
  c.fillStyle = 'rgba(230, 162, 60, 0.9)'
  for (const pl of project.plans) c.fillRect(px(pl.time) - 0.5, 0, 1, h)
  // signets (Tier B) : petits chevrons verts en haut, distincts des scènes/plans
  c.fillStyle = 'rgba(95, 191, 106, 0.95)'
  for (const b of (project.bookmarks || [])) {
    const x = px(b.time)
    c.beginPath(); c.moveTo(x - 4, 0); c.lineTo(x + 4, 0); c.lineTo(x, 5); c.closePath(); c.fill()
  }
}

// tooltip : timecode + scène/plan courants + répliques sous le curseur (max 3)
function seekTipUpdate(e) {
  const dur = seekDur()
  if (!dur) { seekTip.classList.add('hidden'); return }
  const t = seekFrac(e) * dur
  seekTip.innerHTML = ''
  const addRow = (txt, color) => {
    const d = document.createElement('div')
    if (color) {
      const dot = document.createElement('span')
      dot.className = 'tip-dot'
      dot.style.background = color
      d.appendChild(dot)
    }
    d.appendChild(document.createTextNode(txt))
    seekTip.appendChild(d)
    return d
  }
  addRow(formatTc(t, project.fps)).className = 'tip-tc'
  const lp = project.loops.find((k) => t >= k.start && t <= k.end)
  if (lp) addRow(lp.name)
  const pl = sortedPlans().filter((k) => k.time <= t).pop()
  if (pl) addRow(pl.name)
  const bm = (project.bookmarks || []).find((k) => Math.abs(k.time - t) < (seekDur() || 1) * 0.01)
  if (bm) addRow('★ ' + (bm.label || formatTcShort(bm.time)))
  let n = 0
  for (const l of project.lines) {
    if (!l.words.length || t < lineStart(l) || t > lineEnd(l)) continue
    if (++n > 3) { addRow('…'); break }
    const ch = getChar(l.characterId)
    const txt = l.words.map((w) => w.text).join(' ')
    addRow(`${ch?.name || '?'} : ${txt.length > 48 ? txt.slice(0, 48) + '…' : txt}`, ch?.color)
  }
  seekTip.classList.remove('hidden')
  const r = seekBar.getBoundingClientRect()
  seekTip.style.left = clamp(e.clientX - r.left - seekTip.offsetWidth / 2, 4, Math.max(4, r.width - seekTip.offsetWidth - 4)) + 'px'
}

seekBar.addEventListener('pointerdown', (e) => {
  if (!seekDur()) return
  seekBar.setPointerCapture(e.pointerId)
  seekDrag = true
  seekBar.classList.add('dragging')
  scrub.active = true
  scrubTo(seekFrac(e) * seekDur())
})
seekBar.addEventListener('pointermove', (e) => {
  seekTipUpdate(e)
  if (seekDrag) {
    scrubTo(seekFrac(e) * seekDur())
    if (video.paused) playScrubGrain(scrub.time)
  }
})
function seekEndDrag(e) {
  if (!seekDrag) return
  seekDrag = false
  seekBar.classList.remove('dragging')
  scrub.active = false
  if (!scrub.busy && scrub.pending == null) scrub.time = null
  // la capture du pointeur a pu retenir le pointerleave : cacher le tooltip si besoin
  const r = seekBar.getBoundingClientRect()
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) seekTip.classList.add('hidden')
}
seekBar.addEventListener('pointerup', seekEndDrag)
seekBar.addEventListener('pointercancel', seekEndDrag)
seekBar.addEventListener('pointerleave', () => { if (!seekDrag) seekTip.classList.add('hidden') })

function applySeekBarVisibility() {
  seekBar.classList.toggle('hidden', !showSeekBar)
  applyBandHeight() // la barre entre dans le chrome du dock → re-cale la hauteur au toggle
}

$('btnAddLine').addEventListener('click', () => {
  addLineAt(video.currentTime, null, '…', NEW_LINE_DUR)
  focusNewLineText()
})

// ============================================================ réacs (lexique)
// Le lexique vit dans reacs.js (REACS / REAC_BY_KEY). Le token inséré est localisé
// (FR ou EN selon la langue de l'UI). Une réac est posée comme une réplique courte
// (kind='reac' pour le DETX), sans flèche entrée/sortie par défaut — comme une
// réplique normale, l'utilisateur les ajoute s'il le souhaite. Insertion à la
// palette « Réactions » ou directement par la touche du lexique.
const REAC_DUR = 0.2 // durée par défaut d'une réac insérée (1/4 de 0,8 s)
const onomaPop = $('onomaPop')

// token écrit dans le projet/DETX, dans la langue courante
const reacToken = (r) => r[lang] || r.fr

function insertReac(r) {
  pushUndo()
  if (!project.characters.length) addCharacter()
  const start = Math.max(0, effectiveTime())
  const characterId = selectedCharId || project.characters[0].id
  const line = {
    id: uid(),
    characterId,
    track: findFreeTrack(start, start + REAC_DUR, characterId),
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
  symbolPop.classList.add('hidden'); cuePop.classList.add('hidden') // un seul popup ouvert à la fois
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


// ============================================================ signes de détection
// On pose un signe (voir detection.js) sur un mot de la réplique sélectionnée :
// celui sous le point de lecture, sinon le plus proche. Un signe déjà posé est
// retiré si on repose le même (bascule). Persisté dans line.symbols = { [i]: key }
// et donc dans le .rythmo + l'undo (snapshot des lignes). Rendu dans renderBand.
const symbolPop = $('symbolPop')

// mot ciblé dans une réplique pour l'instant donné (contient l'instant, sinon proche)
function symbolTargetWord(line, at) {
  let best = 0, bestD = Infinity
  for (let i = 0; i < line.words.length; i++) {
    const w = line.words[i]
    if (at >= w.start && at < w.end) return i
    const cc = (w.start + w.end) / 2
    const d = Math.abs(cc - at)
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

function insertSymbol(sym) {
  if (selectedIds.size !== 1) { toast(t('symNeedLine')); return }
  const line = getLine([...selectedIds][0])
  if (!line || !line.words || !line.words.length) return
  pushUndo()
  const wi = symbolTargetWord(line, effectiveTime())
  if (!line.symbols) line.symbols = {}
  if (line.symbols[wi] === sym.key) delete line.symbols[wi] // bascule : retire
  else line.symbols[wi] = sym.key
  if (!Object.keys(line.symbols).length) delete line.symbols
  markDirty()
}

function clearLineSymbols() {
  if (selectedIds.size !== 1) { toast(t('symNeedLine')); return }
  const line = getLine([...selectedIds][0])
  if (!line || !line.symbols) return
  pushUndo()
  delete line.symbols
  markDirty()
}

function buildSymbolPop() {
  symbolPop.innerHTML = ''
  for (const s of DET_SYMBOLS) {
    const b = document.createElement('button')
    b.className = 'sym-chip'
    b.title = t('symChipTitle', s[lang] || s.fr, s.hint, s.key)
    const g = document.createElement('span')
    g.className = 'g'
    g.textContent = s.glyph
    const nm = document.createElement('span')
    nm.className = 'nm'
    nm.textContent = s[lang] || s.fr
    const k = document.createElement('span')
    k.className = 'k'
    k.textContent = s.key
    b.append(g, nm, k)
    b.addEventListener('click', () => insertSymbol(s))
    symbolPop.appendChild(b)
  }
  const clr = document.createElement('button')
  clr.className = 'sym-chip sym-clear'
  clr.title = t('symClearTitle')
  clr.textContent = '⌫ ' + t('symClear')
  clr.addEventListener('click', () => clearLineSymbols())
  symbolPop.appendChild(clr)
}
buildSymbolPop()

$('btnSymbols').addEventListener('click', (e) => {
  e.stopPropagation()
  if (!symbolPop.classList.contains('hidden')) { symbolPop.classList.add('hidden'); return }
  onomaPop.classList.add('hidden'); cuePop.classList.add('hidden') // un seul popup ouvert à la fois
  const r = e.currentTarget.getBoundingClientRect()
  symbolPop.style.left = `${r.left}px`
  symbolPop.style.bottom = `${window.innerHeight - r.top + 6}px`
  symbolPop.classList.remove('hidden')
})
document.addEventListener('click', (e) => {
  if (!symbolPop.classList.contains('hidden') && !symbolPop.contains(e.target) && e.target !== $('btnSymbols')) {
    symbolPop.classList.add('hidden')
  }
})


// ============================================================ A6 — repères ADR (streamers / punches)
// Repères de studio posés sur l'image pour lancer le comédien sans lip-sync
// (voice-over, audiodescription, localisation de jeu). Un streamer est une barre
// verticale qui balaie l'image et atteint le bord au top de départ ; un punch est
// un flash circulaire au top. project.cues = [{ id, type, time, lead? }].
const STREAMER_LEAD = 3 // s : durée du balayage du streamer avant le top
const cuePop = $('cuePop')
let selectedCueId = null // repère ADR sélectionné sur la bande (déplaçable / supprimable)
const CUE_COL = '#5cc8f0' // cyan, distinct des plans (ambre) et du playhead (rouge)

// rendu des repères sur la bande (timeline) : ligne guide verticale + marqueur dans la
// règle (cercle = punch, fanion = streamer, + barre de lead). Le repère sélectionné
// est mis en valeur. Sélection/déplacement/suppression gérés dans les handlers pointeur.
function drawCuesTimeline() {
  const cues = project.cues || []
  if (!cues.length) return
  const now = effectiveTime()
  const cy = 14
  ctx.save()
  for (const q of cues) {
    const x = xAtTime(q.time, now)
    const sel = q.id === selectedCueId
    if (q.type === 'streamer') { // barre de lead (de time-lead à time)
      const x0 = xAtTime(q.time - (q.lead || STREAMER_LEAD), now)
      ctx.strokeStyle = CUE_COL
      ctx.globalAlpha = sel ? 0.9 : 0.5
      ctx.lineWidth = sel ? 3 : 2
      ctx.beginPath(); ctx.moveTo(Math.max(0, x0), RULER_H - 4.5); ctx.lineTo(Math.min(cw, x), RULER_H - 4.5); ctx.stroke()
    }
    if (x < -14 || x > cw + 14) continue
    ctx.strokeStyle = CUE_COL // ligne guide verticale
    ctx.globalAlpha = sel ? 0.85 : 0.32
    ctx.lineWidth = sel ? 2 : 1
    ctx.beginPath(); ctx.moveTo(x + 0.5, RULER_H); ctx.lineTo(x + 0.5, ch); ctx.stroke()
    ctx.globalAlpha = 1 // marqueur dans la règle
    ctx.fillStyle = CUE_COL
    ctx.strokeStyle = sel ? '#ffffff' : CUE_COL
    ctx.lineWidth = 1.5
    if (q.type === 'punch') {
      ctx.beginPath(); ctx.arc(x, cy, sel ? 6 : 5, 0, Math.PI * 2); ctx.fill()
      if (sel) ctx.stroke()
    } else {
      const s = sel ? 6 : 5
      ctx.beginPath(); ctx.moveTo(x - s, cy - s); ctx.lineTo(x + s, cy); ctx.lineTo(x - s, cy + s); ctx.closePath(); ctx.fill()
      if (sel) ctx.stroke()
    }
  }
  ctx.restore()
}

// id du repère dont le marqueur (ou la ligne guide) est à moins de ~7 px de x, sinon null
function hitCueX(x) {
  const cues = project.cues || []
  if (!cues.length) return null
  const now = effectiveTime()
  let best = null, bd = 7
  for (const q of cues) { const d = Math.abs(xAtTime(q.time, now) - x); if (d <= bd) { bd = d; best = q.id } }
  return best
}

function deleteSelectedCue() {
  if (!selectedCueId) return
  const cues = project.cues || []
  const i = cues.findIndex((c) => c.id === selectedCueId)
  if (i < 0) { selectedCueId = null; return }
  pushUndo(); cues.splice(i, 1); selectedCueId = null; markDirty(); toast(t('cueRemoved'))
}

function drawPunchRing(c, r) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  const rad = Math.min(r.w, r.h) * 0.09
  c.save()
  c.lineWidth = Math.max(3, rad * 0.22)
  c.strokeStyle = 'rgba(255,255,255,0.95)'
  c.fillStyle = 'rgba(255,255,255,0.28)'
  c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.fill()
  c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.stroke()
  c.restore()
}

// dessine les repères actifs à l'instant `now` dans le rectangle image `r` (x,y,w,h)
function drawCues(c, r, now) {
  const cues = project.cues || []
  if (!cues.length) return
  const fps = project.fps || 25
  const flash = Math.max(2 / fps, 0.08) // fenêtre d'affichage d'un flash de punch
  for (const q of cues) {
    if (q.type === 'streamer') {
      const lead = q.lead || STREAMER_LEAD
      const t0 = q.time - lead
      if (now >= t0 && now <= q.time + flash) {
        const p = clamp((now - t0) / lead, 0, 1)
        const x = r.x + p * r.w
        c.save()
        c.strokeStyle = 'rgba(255,228,80,0.95)'
        c.lineWidth = Math.max(2, r.w * 0.005)
        c.beginPath(); c.moveTo(x, r.y); c.lineTo(x, r.y + r.h); c.stroke()
        c.restore()
      }
      if (Math.abs(now - q.time) <= flash) drawPunchRing(c, r) // top de fin
    } else if (q.type === 'punch') {
      if (Math.abs(now - q.time) <= flash) drawPunchRing(c, r)
    }
  }
}

// overlay ADR de l'éditeur : un canvas calé sur le rectangle vidéo affiché
function drawCuesEditor() {
  const ov = $('cueOverlay')
  if (!ov) return
  if (!(video.videoWidth > 0) || !(project.cues || []).length) { if (!ov.hidden) ov.hidden = true; return }
  const vr = video.getBoundingClientRect()
  const wr = $('videoWrap').getBoundingClientRect()
  const w = Math.round(vr.width), h = Math.round(vr.height)
  if (w < 2 || h < 2) { ov.hidden = true; return }
  ov.hidden = false
  ov.style.left = (vr.left - wr.left) + 'px'
  ov.style.top = (vr.top - wr.top) + 'px'
  ov.style.width = w + 'px'
  ov.style.height = h + 'px'
  const dpr = window.devicePixelRatio || 1
  if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr) }
  const c = ov.getContext('2d')
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, w, h)
  drawCues(c, { x: 0, y: 0, w, h }, effectiveTime())
}

function addCue(type) {
  pushUndo()
  if (!project.cues) project.cues = []
  const time = Math.max(0, effectiveTime())
  const cue = { id: uid(), type, time }
  if (type === 'streamer') cue.lead = STREAMER_LEAD
  project.cues.push(cue)
  selectedCueId = cue.id // le nouveau repère est sélectionné (déplaçable / supprimable de suite)
  markDirty()
  toast(t(type === 'streamer' ? 'cueStreamerAdded' : 'cuePunchAdded'))
}

function removeNearestCue() {
  const cues = project.cues || []
  if (!cues.length) { toast(t('cueNone')); return }
  const now = effectiveTime()
  let bi = -1, bd = Infinity
  for (let i = 0; i < cues.length; i++) { const d = Math.abs(cues[i].time - now); if (d < bd) { bd = d; bi = i } }
  if (bi >= 0) { pushUndo(); const [rm] = cues.splice(bi, 1); if (rm && rm.id === selectedCueId) selectedCueId = null; markDirty(); toast(t('cueRemoved')) }
}

function clearCues() {
  if (!(project.cues || []).length) { toast(t('cueNone')); return }
  pushUndo(); project.cues = []; selectedCueId = null; markDirty(); toast(t('cuesCleared'))
}

function buildCuePop() {
  cuePop.innerHTML = ''
  const mk = (label, fn) => {
    const b = document.createElement('button')
    b.className = 'cue-item'
    b.textContent = label
    b.addEventListener('click', () => { fn(); cuePop.classList.add('hidden') })
    cuePop.appendChild(b)
  }
  mk(t('cueAddStreamer'), () => addCue('streamer'))
  mk(t('cueAddPunch'), () => addCue('punch'))
}
buildCuePop()

$('btnAdr').addEventListener('click', (e) => {
  e.stopPropagation()
  if (!cuePop.classList.contains('hidden')) { cuePop.classList.add('hidden'); return }
  onomaPop.classList.add('hidden'); symbolPop.classList.add('hidden') // un seul popup ouvert à la fois
  const r = e.currentTarget.getBoundingClientRect()
  cuePop.style.left = `${r.left}px`
  cuePop.style.bottom = `${window.innerHeight - r.top + 6}px`
  cuePop.classList.remove('hidden')
})
document.addEventListener('click', (e) => {
  if (!cuePop.classList.contains('hidden') && !cuePop.contains(e.target) && e.target !== $('btnAdr')) {
    cuePop.classList.add('hidden')
  }
})


// ============================================================ keyboard
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase()
  const typing = tag === 'input' || tag === 'select' || tag === 'textarea'

  // mode lecture plein écran : F5 entre/sort, Échap sort ; sinon lecture/navigation seulement
  if (e.key === 'F5') { e.preventDefault(); player.open ? closePlayer() : openPlayer(); return }
  if (player.open) {
    if (e.key === 'Escape') { e.preventDefault(); closePlayer(); return }
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); showPlayerControls(); break
      case 'ArrowLeft': e.preventDefault(); video.pause(); video.currentTime = clamp(video.currentTime - (e.shiftKey ? 1 : 1 / project.fps), 0, videoDur()); showPlayerControls(); break
      case 'ArrowRight': e.preventDefault(); video.pause(); video.currentTime = clamp(video.currentTime + (e.shiftKey ? 1 : 1 / project.fps), 0, videoDur()); showPlayerControls(); break
      case 'PageUp': e.preventDefault(); gotoLoop(-1); showPlayerControls(); break
      case 'PageDown': e.preventDefault(); gotoLoop(1); showPlayerControls(); break
    }
    return
  }

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

  // onglet Pistes : seul Suppr (piste importée sélectionnée) est géré ici ; les autres
  // raccourcis liés aux répliques (copier/coller, sélection, réacs, Entrée) sont inactifs
  if (activeTab === 'tracks') {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTrackId) { e.preventDefault(); deleteTrack(selectedTrackId) }
    // on laisse passer Espace / flèches / Page↑↓ / Ctrl+Z·Y (gérés plus bas, indépendants de l'onglet)
  }

  // onglet Enregistrement : Suppr efface le segment sélectionné
  if (activeTab === 'rec' && (e.key === 'Delete' || e.key === 'Backspace') && selectedClipId) {
    e.preventDefault(); deleteClip(selectedClipId); return
  }

  // copier / couper / coller des répliques sélectionnées (onglet Rythmo)
  if (activeTab === 'rythmo') {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copyLines(); return }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { e.preventDefault(); copyLines(); deleteSelected(); return }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteLines(); return }
  }

  // chiffres 1-9 : sélectionne le Nième personnage (destinataire des nouvelles répliques)
  // On lit e.code (Digit1..Digit9 / Numpad1..Numpad9), position physique de la touche,
  // pour que ça marche quelle que soit la disposition (AZERTY : &é"'(-è_ç, etc.)
  const digitCode = e.code && e.code.match(/^(?:Digit|Numpad)([1-9])$/)
  if (digitCode && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const idx = Number(digitCode[1]) - 1
    if (idx < project.characters.length) {
      if (activeTab === 'rythmo' || activeTab === 'rec') { e.preventDefault(); selectedCharId = project.characters[idx].id; renderChars(); return }
    }
  }

  // palette de détection ouverte : les touches posent un signe de détection sur la
  // réplique sélectionnée (et court-circuitent le lexique des réacs)
  if (activeTab === 'rythmo' && !symbolPop.classList.contains('hidden') &&
      !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    const sym = DET_BY_KEY.get(e.key)
    if (sym) { e.preventDefault(); insertSymbol(sym); return }
  }

  // touche du lexique = insertion directe d'une réac au point de lecture (onglet Rythmo)
  if (activeTab === 'rythmo' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    const reac = REAC_BY_KEY.get(e.key)
    if (reac) {
      e.preventDefault()
      insertReac(reac)
      return
    }
  }

  if (activeTab === 'rythmo' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectedIds = new Set(project.lines.map((l) => l.id))
    refreshInspector()
    return
  }

  // signets (Tier B) — indépendants de l'onglet : Ctrl+B pose/retire, Ctrl+,/. navigue
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleBookmark(); return }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); gotoBookmark(-1); return }
  if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); gotoBookmark(1); return }

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
      if (activeTab !== 'rythmo') break
      e.preventDefault()
      addLineAt(video.currentTime, null, '…', NEW_LINE_DUR)
      focusNewLineText()
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
      if (activeTab === 'rythmo') { if (selectedCueId) deleteSelectedCue(); else deleteSelected() }
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
  syncPlaybackAudio() // plus de piste active → retour à l'audio natif (silencieux ici)
  videoInfo = null
  proxyToken++ // annule une génération de proxy éventuellement en cours
  proxyActive = false
  usingProxy = false
  videoProxyPath = null
  sourceVideoUrl = null
  hideProxyStatus()
  window.api.cancelProxy()
  video.removeAttribute('src')
  video.load()
  setDropHint()
  updateVideoInfoPanel()
  renderChars()
  panelH = null // nouveau projet → dock à la hauteur max
  applyBandHeight()
  buildInsTrackOptions() // re-cale le sélecteur « Piste » sur le nombre de pistes par défaut
  refreshTrackCountUI()
  lineFilterTrack = null
  buildLineFilterOptions()
  refreshInspector()
  renderLinesLog()
  renderLoopsPanel()
  renderPlansPanel()
  if (activeTab === 'tracks') renderTracks()
  setClean()
  updateDiscordActivity()
}

// invite « Glisse une vidéo ici » — textes par défaut, ou message personnalisé
// (vidéo du projet introuvable)
function setDropHint(main, sub) {
  $('dropHintMain').textContent = main || t('dropMain')
  $('dropHintSub').textContent = sub || t('dropSub')
  $('dropHint').style.display = ''
}

async function setVideo(path, url) {
  project.videoPath = path
  project.audioTracks = [] // nouveau conteneur → pistes re-sondées (probeAndSyncAudio)
  videoInfo = null
  usingProxy = false
  videoProxyPath = null
  sourceVideoUrl = url
  showLoading(true, t('loadingVideo'))
  if (typeof resetImgZoom === 'function') resetImgZoom()
  video.src = url
  $('dropHint').style.display = 'none'
  markDirty()
  buildWaveform()
  updateDiscordActivity()
  generateProxy(path) // tâche de fond ; bascule le lecteur sur le proxy quand prêt
}

async function openVideoDialog() {
  const r = await window.api.openVideo()
  if (r) setVideo(r.path, r.url)
}

// ============================================================ import YouTube (yt-dlp)
// URL collée → sonde auto (titre, durée, qualités DISPONIBLES) → téléchargement →
// la modale s'élargit en bas avec un rognage début/fin → Valider charge la vidéo.
const ytModal = $('ytModal')
const ytSt = { busy: false, meta: null, file: null, probeTimer: 0, probedUrl: null, phase: 'idle' }
const YT_RUNGS = [720, 1080, 1440, 2160]
const ytFmtTc = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
async function openYtModal() {
  ytModal.classList.remove('hidden')
  ytSt.phase = 'idle'; ytSt.meta = null; ytSt.file = null; ytSt.probedUrl = null
  $('ytBar').style.width = '0%'; $('ytStatus').textContent = ''
  $('ytTrimSec').classList.add('hidden')
  $('ytQuality').innerHTML = ''; $('ytQuality').disabled = true
  $('ytInfo').textContent = ''
  $('ytUrl').value = ''; $('ytUrl').disabled = false
  $('ytGo').textContent = t('ytGoImport'); $('ytGo').disabled = false
  if (!$('ytDir').value) $('ytDir').value = await window.api.ytDefaultDir()
  $('ytUrl').focus()
}
// sélecteur de qualité : uniquement les paliers réellement disponibles
function ytFillQuality(heights) {
  const maxH = Math.max(0, ...heights)
  const sel = $('ytQuality'); sel.innerHTML = ''
  const rungs = YT_RUNGS.filter((h) => maxH >= h - 66)
  if (!rungs.length && maxH) rungs.push(maxH)
  for (const h of rungs) {
    const o = document.createElement('option'); o.value = String(h)
    o.textContent = h >= 2160 ? '2160p (4K)' : h >= 1440 ? '1440p (2K)' : `${h}p`
    sel.appendChild(o)
  }
  sel.value = String(rungs.includes(1080) ? 1080 : rungs[rungs.length - 1] || 1080)
  sel.disabled = !rungs.length
}
async function ytDoProbe() {
  const url = $('ytUrl').value.trim()
  if (!/^https?:\/\//i.test(url)) { toast(t('ytBadUrl')); return null }
  if (ytSt.meta && ytSt.probedUrl === url) return ytSt.meta
  ytSt.busy = true; $('ytGo').disabled = true
  $('ytStatus').textContent = t('ytPhProbe')
  const r = await window.api.ytProbe(url)
  ytSt.busy = false; $('ytGo').disabled = false
  if (!r || r.error) { $('ytStatus').textContent = t('ytFail') + (r && r.error ? ' — ' + String(r.error).slice(0, 80) : ''); return null }
  ytSt.meta = r; ytSt.probedUrl = url
  ytFillQuality(r.heights || [])
  $('ytInfo').textContent = `${r.title.slice(0, 46)} · ${ytFmtTc(r.duration)}`
  $('ytStatus').textContent = ''
  return r
}
$('ytUrl').addEventListener('input', () => {
  clearTimeout(ytSt.probeTimer)
  ytSt.meta = null
  if (/^https?:\/\/\S+$/i.test($('ytUrl').value.trim())) ytSt.probeTimer = setTimeout(ytDoProbe, 700)
})
$('ytBrowse').addEventListener('click', async () => { const p = await window.api.pickDirectory($('ytDir').value || undefined); if (p) $('ytDir').value = p })
window.api.onYtProgress((p) => {
  if (!p || ytModal.classList.contains('hidden')) return
  if (p.phase === 'ytdlp') { $('ytBar').style.width = (p.pct || 0) + '%'; $('ytStatus').textContent = t('ytPhYtdlp', p.pct || 0) }
  else if (p.phase === 'probe') $('ytStatus').textContent = t('ytPhProbe')
  else if (p.phase === 'download') { $('ytBar').style.width = (p.pct || 0) + '%'; $('ytStatus').textContent = t('ytPhDl', p.pct || 0) }
  else if (p.phase === 'trim') $('ytStatus').textContent = t('ytPhTrim')
})
function ytSyncTrimLabels() {
  const dur = ytSt.meta ? ytSt.meta.duration : 0
  $('ytStartVal').textContent = ytFmtTc((Number($('ytStart').value) / 1000) * dur)
  $('ytEndVal').textContent = ytFmtTc((Number($('ytEnd').value) / 1000) * dur)
}
$('ytStart').addEventListener('input', () => { if (Number($('ytStart').value) > Number($('ytEnd').value) - 10) $('ytStart').value = String(Number($('ytEnd').value) - 10); ytSyncTrimLabels() })
$('ytEnd').addEventListener('input', () => { if (Number($('ytEnd').value) < Number($('ytStart').value) + 10) $('ytEnd').value = String(Number($('ytStart').value) + 10); ytSyncTrimLabels() })
async function ytGoClick() {
  if (ytSt.busy) return
  if (ytSt.phase === 'trim') {
    // Valider : rognage éventuel (copie sans ré-encodage) puis chargement de la vidéo
    const dur = ytSt.meta ? ytSt.meta.duration : 0
    const s = (Number($('ytStart').value) / 1000) * dur
    const e2 = (Number($('ytEnd').value) / 1000) * dur
    ytSt.busy = true; $('ytGo').disabled = true
    let file = ytSt.file
    if (dur && (s > 0.2 || e2 < dur - 0.2)) {
      const r = await window.api.ytTrim({ path: file, start: s, end: e2 })
      if (!r || r.error) { $('ytStatus').textContent = t('ytFail'); ytSt.busy = false; $('ytGo').disabled = false; return }
      file = r.path
    }
    ytSt.busy = false; $('ytGo').disabled = false
    ytModal.classList.add('hidden')
    const url = await window.api.fileUrl(file)
    if (url) setVideo(file, url)
    toast(t('ytDone'))
    return
  }
  const meta = await ytDoProbe(); if (!meta) return
  ytSt.busy = true; $('ytGo').disabled = true; $('ytUrl').disabled = true; $('ytQuality').disabled = true
  const r = await window.api.ytDownload({ url: ytSt.probedUrl, height: Number($('ytQuality').value) || 1080, destDir: $('ytDir').value.trim(), title: meta.title, id: meta.id })
  ytSt.busy = false; $('ytGo').disabled = false; $('ytUrl').disabled = false; $('ytQuality').disabled = false
  if (!r || r.error) { $('ytStatus').textContent = t('ytFail') + (r && r.error ? ' — ' + String(r.error).slice(0, 90) : ''); return }
  ytSt.file = r.path
  ytSt.phase = 'trim'
  $('ytBar').style.width = '100%'
  $('ytStatus').textContent = t('ytDlDone')
  $('ytTrimSec').classList.remove('hidden') // la modale s'élargit en bas : rognage début/fin
  $('ytStart').value = '0'; $('ytEnd').value = '1000'; ytSyncTrimLabels()
  $('ytGo').textContent = t('ytGoApply')
}
$('ytGo').addEventListener('click', ytGoClick)
$('ytClose').addEventListener('click', () => { if (!ytSt.busy) { window.api.ytCancel(); ytModal.classList.add('hidden') } })
$('dropBrowse').addEventListener('click', openVideoDialog)
$('dropYt').addEventListener('click', openYtModal)

// sérialise le projet en estampillant la position de lecture courante, pour reprendre
// au même timecode à la réouverture du projet
function projectJson() {
  project.playhead = Math.max(0, effectiveTime() || 0)
  project.activeAudioKey = audioTrackKey(activeAudioTrack()) // clé stable de la piste active
  return JSON.stringify(project, null, 2)
}

// nom proposé au 1er enregistrement : nom du fichier vidéo (sans extension) + .rythmo
function suggestedProjectName() {
  return project.videoPath ? baseName(project.videoPath).replace(/\.[^.]+$/, '') + '.rythmo' : ''
}

async function saveProject() {
  const json = projectJson()
  const p = await window.api.saveProject(json, projectPath, suggestedProjectName())
  if (p) {
    projectPath = p
    setClean()
    updateDiscordActivity()
    toast(t('saved'))
  }
}
async function saveProjectAs() {
  const p = await window.api.saveProjectAs(projectJson(), projectPath)
  if (p) {
    projectPath = p
    setClean()
    updateDiscordActivity()
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
  project.version = 2 // les anciens projets (v1) se rouvrent et sont ré-enregistrés en v2
  project.characters ||= []
  project.lines ||= []
  project.loops ||= []
  project.plans ||= []
  project.fonts ||= []
  project.defaultFont ||= null
  // ré-enregistre les polices embarquées du projet (FontFace) avant le 1er rendu
  await registerAllFonts()
  populateFontSelects()
  // rétrocompat : modèle v2 « sources.audioTracks » accepté, sinon liste vide
  project.audioTracks ||= (data.sources && data.sources.audioTracks) || []
  // nombre de pistes : valeur enregistrée si présente, sinon déduite des données
  // (les anciens projets sans champ `tracks` ne doivent jamais masquer une piste)
  const maxUsed = project.lines.reduce((m, l) => Math.max(m, l.track || 0), -1)
  project.tracks = clamp(Math.max(data.tracks || DEFAULT_TRACKS, maxUsed + 1), 1, MAX_TRACKS)
  projectPath = path || null
  selectedCharId = project.characters[0]?.id || null
  selectedIds = new Set()
  selectedCueId = null
  undoStack = []
  redoStack = []
  syncUndoMenu()
  renderChars()
  panelH = null // charger un projet → dock à la hauteur max (toutes les pistes visibles)
  applyBandHeight()
  buildInsTrackOptions() // le sélecteur « Piste » de l'inspecteur suit les pistes du projet
  refreshTrackCountUI() // idem pour le menu « Pistes » de la barre de transport
  lineFilterTrack = null
  buildLineFilterOptions()
  refreshInspector()
  renderLinesLog()
  renderLoopsPanel()
  renderPlansPanel()
  preloadTakeAudios()
  setClean()
  updateDiscordActivity()
  usingProxy = false
  videoProxyPath = null
  sourceVideoUrl = null
  if (project.videoPath) {
    const url = await window.api.fileUrl(project.videoPath)
    if (url) {
      videoInfo = null
      sourceVideoUrl = url
      showLoading(true, t('loadingProject'))
      video.src = url
      // reprend au timecode enregistré dans le projet (position de lecture au dernier save)
      const resumeAt = Math.max(0, Number(project.playhead) || 0)
      if (resumeAt > 0.05) {
        video.addEventListener('loadedmetadata', function once() {
          video.removeEventListener('loadedmetadata', once)
          try { video.currentTime = Math.min(resumeAt, video.duration || resumeAt) } catch {}
        })
      }
      $('dropHint').style.display = 'none'
      buildWaveform()
      generateProxy(project.videoPath) // tâche de fond ; bascule sur le proxy quand prêt
    } else {
      // vidéo introuvable : lecteur vidé (l'ancienne vidéo ne doit pas rester
      // affichée) + invite persistante — le toast seul disparaît trop vite
      video.removeAttribute('src')
      video.load()
      setDropHint(t('videoNotFoundHint'), t('videoNotFoundSub'))
      updateVideoInfoPanel()
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

// VTT : très proche du SRT (cues + timestamps), mais heures optionnelles et balises
// de cue (<c>, <v Speaker>, timestamps internes) à ignorer ; on ne garde que texte + timing.
function parseVtt(text) {
  const cues = []
  const reTime = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})/
  const frac = (s) => +s / Math.pow(10, s.length)
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.trim().split('\n')
    const ti = lines.findIndex((l) => reTime.test(l))
    if (ti === -1) continue
    const m = lines[ti].match(reTime)
    const start = (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + frac(m[4])
    const end = (+m[5] || 0) * 3600 + +m[6] * 60 + +m[7] + frac(m[8])
    const txt = lines.slice(ti + 1).join(' ')
      .replace(/<[^>]+>/g, '') // balises de cue (voix, classes, timestamps)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim()
    if (txt && end > start) cues.push({ start, end, text: txt })
  }
  return cues
}

// ASS/SSA : on ne lit que les Dialogue: de la section [Events] (texte + timing) ;
// styles, positions, karaoké et tags d'override {\...} sont ignorés pour rester simple.
function parseAss(text) {
  const cues = []
  const toSec = (s) => {
    const m = String(s).trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{1,3})/)
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / Math.pow(10, m[4].length) : null
  }
  let section = ''
  let fields = null // ordre des champs déclaré par la ligne Format: de [Events]
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) { section = sec[1].toLowerCase(); continue }
    if (section !== 'events') continue
    if (/^Format:/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim().toLowerCase())
      continue
    }
    if (!/^Dialogue:/i.test(line)) continue
    const f = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    const iStart = f.indexOf('start'), iEnd = f.indexOf('end'), iText = f.indexOf('text')
    if (iStart < 0 || iEnd < 0 || iText < 0) continue
    // le texte est le dernier champ et peut contenir des virgules : on ne découpe
    // qu'en (nb champs − 1) morceaux pour le préserver intact
    const parts = line.slice(line.indexOf(':') + 1).split(',')
    const cols = [...parts.slice(0, f.length - 1), parts.slice(f.length - 1).join(',')]
    const start = toSec(cols[iStart]), end = toSec(cols[iEnd])
    const txt = (cols[iText] || '')
      .replace(/\{[^}]*\}/g, '') // tags d'override
      .replace(/\\[Nnh]/g, ' ')  // sauts de ligne / espace insécable ASS
      .replace(/\s+/g, ' ').trim()
    if (txt && start != null && end != null && end > start) cues.push({ start, end, text: txt })
  }
  return cues
}

// sélection du parser d'après le contenu (robuste quelle que soit l'extension)
function sniffSubs(text) {
  if (/^﻿?\s*WEBVTT/.test(text)) return parseVtt
  if (/\[Script Info\]|\[Events\]/i.test(text) || /^\s*Dialogue:/im.test(text)) return parseAss
  return parseSrt
}

function importSubsText(text) {
  const cues = sniffSubs(text)(text)
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
      track: findFreeTrack(cue.start, cue.end, charId),
      words: splitWords(cue.text, cue.start, cue.end),
    })
  }
  markDirty()
  toast(t('srtImported', cues.length))
}

async function importSubsDialog() {
  const text = await window.api.importSubs()
  if (text) importSubsText(text)
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

// ============================================================ documents PDF — titre commun
// Titre des documents PDF (grille de présence, relevé de lignes) : nom du projet ou
// de la vidéo.
function scriptTitle() {
  return (projectPath || project.videoPath || 'Script').replace(/^.*[\\/]/, '').replace(/\.\w+$/, '') || 'Script'
}

// ============================================================ A5 — documents de travail
// Deux documents PDF pour organiser une session d'enregistrement (mêmes rouages
// que le script : HTML → printToPDF côté process principal via window.api.exportPdf).
//   · grille de présence : personnages × scènes, qui parle où (nb de répliques)
//   · relevé de lignes : par personnage, ses répliques (TC + texte) + case cochée
const DOC_CSS = `* { box-sizing: border-box; }
  body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #111; margin: 0; }
  .title { font-size: 17pt; font-weight: bold; margin: 0 0 3pt; }
  .meta { color: #777; font-size: 9pt; margin-bottom: 14pt; text-transform: uppercase; letter-spacing: .5pt; }
  .rule { border-bottom: 1.5px solid #111; margin-bottom: 16pt; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #bbb; padding: 4pt 6pt; text-align: center; font-size: 9pt; }
  thead th { background: #f0f0f0; }
  th.nm { text-align: left; white-space: nowrap; }
  td.p { background: #e9f2ff; font-weight: bold; }
  td.tot, th.tot { background: #f7f7f7; font-weight: bold; }
  tr.totals td, tr.totals th { background: #f0f0f0; font-weight: bold; }
  .dot { width: 8pt; height: 8pt; border-radius: 50%; display: inline-block; margin-right: 5pt; transform: translateY(1pt); }
  h2.grp { font-size: 12pt; margin: 16pt 0 4pt; page-break-after: avoid; }
  h2.grp .dot { width: 10pt; height: 10pt; }
  table.tally td.tc { color: #555; width: 88pt; white-space: nowrap; text-align: left; }
  table.tally td.d { text-align: left; }
  table.tally td.rec { width: 34pt; }
  table.tally td.n { width: 26pt; color: #777; }`

function docHead(title, sub, count, unit) {
  let date = ''
  try { date = new Date().toLocaleDateString(lang === 'fr' ? 'fr-FR' : lang === 'es' ? 'es-ES' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }) } catch {}
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><style>${DOC_CSS}</style></head><body>` +
    `<div class="title">${xmlEsc(title)}</div>` +
    `<div class="meta">${xmlEsc(sub)}${date ? ' · ' + xmlEsc(date) : ''} · ${count} ${xmlEsc(unit)}</div>` +
    `<div class="rule"></div>`
}

function docScenes() {
  const scenes = [...project.loops].sort((a, b) => a.start - b.start)
  if (scenes.length) return scenes
  const maxEnd = project.lines.reduce((m, l) => Math.max(m, lineEnd(l)), 0)
  return [{ id: 'all', name: t('docAllScenes'), start: 0, end: maxEnd || 1 }]
}

function buildPresenceHtml() {
  const chars = project.characters.slice()
  const scenes = docScenes()
  const inScene = (l, sc) => { const m = (lineStart(l) + lineEnd(l)) / 2; return m >= sc.start && m < sc.end }
  const header = scenes.map((sc) => `<th>${xmlEsc(sc.name)}</th>`).join('')
  let body = ''
  const perScene = scenes.map(() => 0)
  for (const c of chars) {
    const lines = project.lines.filter((l) => l.characterId === c.id && l.words.length)
    const cells = scenes.map((sc, i) => {
      const n = lines.filter((l) => inScene(l, sc)).length
      perScene[i] += n
      return `<td class="${n ? 'p' : ''}">${n ? '●' + (n > 1 ? ' ' + n : '') : ''}</td>`
    }).join('')
    body += `<tr><th class="nm"><span class="dot" style="background:${xmlEsc(c.color)}"></span>${xmlEsc(c.name)}</th>${cells}<td class="tot">${lines.length}</td></tr>`
  }
  const totals = `<tr class="totals"><th class="nm">${xmlEsc(t('docTotal'))}</th>` +
    perScene.map((n) => `<td>${n || ''}</td>`).join('') +
    `<td class="tot">${project.lines.filter((l) => l.words.length).length}</td></tr>`
  return docHead(scriptTitle(), t('docPresenceSub'), chars.length, t('docCharsUnit')) +
    `<table><thead><tr><th class="nm">${xmlEsc(t('docCharacter'))}</th>${header}<th class="tot">${xmlEsc(t('docTotal'))}</th></tr></thead>` +
    `<tbody>${body}${totals}</tbody></table></body></html>`
}

function buildTallyHtml() {
  const chars = project.characters.slice()
  let body = ''
  let grand = 0
  for (const c of chars) {
    const lines = project.lines.filter((l) => l.characterId === c.id && l.words.length)
      .sort((a, b) => lineStart(a) - lineStart(b))
    if (!lines.length) continue
    grand += lines.length
    const rows = lines.map((l, i) => {
      const tc = formatTc(lineStart(l), project.fps)
      const text = l.words.map((w) => w.text).filter((w) => w !== '_').join(' ')
      return `<tr><td class="n">${i + 1}</td><td class="tc">${xmlEsc(tc)}</td><td class="d">${xmlEsc(text)}</td><td class="rec">☐</td></tr>`
    }).join('')
    body += `<h2 class="grp"><span class="dot" style="background:${xmlEsc(c.color)}"></span>${xmlEsc(c.name.toUpperCase())} · ${lines.length}</h2>` +
      `<table class="tally"><thead><tr><th class="n">#</th><th class="tc">TC</th><th class="d">${xmlEsc(t('docLine'))}</th><th class="rec">${xmlEsc(t('docRec'))}</th></tr></thead><tbody>${rows}</tbody></table>`
  }
  return docHead(scriptTitle(), t('docTallySub'), grand, t('docLinesUnit')) + body + `</body></html>`
}

async function exportWorkDoc(kind) {
  if (!project.lines.length) { toast(t('noLinesToExport')); return }
  const base = (projectPath || project.videoPath || 'librerythmo').replace(/\.rythmo(\.json)?$/i, '').replace(/\.\w+$/, '')
  const suffix = kind === 'presence' ? '-presence' : '-releve'
  const html = kind === 'presence' ? buildPresenceHtml() : buildTallyHtml()
  const r = await window.api.exportPdf(html, base + suffix + '.pdf')
  if (r && r.error) { toast(t('pdfFailed')); console.error('workdoc:', r.error); return }
  if (r) toast(t('pdfExported', r.replace(/^.*[\\/]/, '')))
}

// menu natif → actions
window.api.onMenu((action, arg) => {
  if (action === 'new-project') newProjectAction()
  else if (action === 'open-video') openVideoDialog()
  else if (action === 'open-project') openProjectDialog()
  else if (action === 'save-project') saveProject()
  else if (action === 'save-project-as') saveProjectAs()
  else if (action === 'import-srt') importSubsDialog()
  else if (action === 'export-srt') exportSrtDialog()
  else if (action === 'update-srt') updateSrtDialog()
  else if (action === 'import-detx') importDetxDialog()
  else if (action === 'import-detx-roles') importDetxRolesDialog()
  else if (action === 'export-detx') exportDetxDialog()
  else if (action === 'export-presence') exportWorkDoc('presence')
  else if (action === 'export-tally') exportWorkDoc('tally')
  else if (action === 'transcribe') openTranscribeDialog()
  else if (action === 'remove-voices') openSeparateDialog()
  else if (action === 'open-settings') openSettings()
  else if (action === 'toggle-wave') { showWave = !!arg; pushSettings() }
  else if (action === 'export-video') openExportModal()
  else if (action === 'export-takes') openTakesExport()
  else if (action === 'import-youtube') openYtModal()
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
  else if (action === 'toggle-subtitles') {
    showSubs = !!arg
    updateSubOverlay()
    pushSettings()
  }
  else if (action === 'toggle-seekbar') {
    showSeekBar = !!arg
    applySeekBarVisibility()
    pushSettings()
  }
  else if (action === 'toggle-autofocus') {
    autofocusText = !!arg
    pushSettings()
  }
  else if (action === 'toggle-discord') {
    discordOn = !!arg
    pushSettings()
    updateDiscordActivity()
  }
  else if (action === 'clear-proxy-cache') clearProxyCache()
})

async function clearProxyCache() {
  // ne pas supprimer le proxy en cours d'utilisation : on l'annule d'abord
  proxyToken++
  proxyActive = false
  hideProxyStatus()
  await window.api.cancelProxy()
  const r = await window.api.clearProxyCache()
  const n = (r && r.count) || 0
  const mb = r && r.bytes ? Math.max(1, Math.round(r.bytes / 1e6)) : 0
  toast(n ? t('proxyCacheCleared', n, mb) : t('proxyCacheEmpty'))
  // si on jouait un proxy, on revient à la source (le fichier vient d'être supprimé)
  if (usingProxy && sourceVideoUrl) {
    usingProxy = false
    videoProxyPath = null
    const at = video.currentTime
    const wasPaused = video.paused
    video.src = sourceVideoUrl
    video.addEventListener('loadedmetadata', function once() {
      video.removeEventListener('loadedmetadata', once)
      try { video.currentTime = at } catch {}
      if (!wasPaused) video.play().catch(() => {})
    })
  }
}

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
  if (/\.(srt|vtt|ass|ssa)$/.test(name)) {
    importSubsText(await file.text())
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
  fpsMode: '60', // 'source' | '30' | '60' | '120' | 'custom' — cadence de sortie (défaut 60)
  winSec: 3, // secondes visibles sur la bande exportée (même zoom que l'éditeur)
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

// cadence source détectée de la vidéo (métadonnées), repli sur project.fps
const sourceFps = () => clamp(Math.round(videoInfo?.fpsExact || project.fps), 10, 120)
// cadence de sortie effective selon le dropdown : Source / 30 / 60 / 120 / Custom
function effectiveExportFps() {
  const m = exp.fpsMode
  if (m === 'source') return sourceFps()
  if (m === 'custom') return clamp(Number($('expFps').value) || project.fps, 10, 120)
  return clamp(Number(m) || 60, 10, 120)
}
// rafraîchit le libellé « Source (25) » et l'affichage du champ manuel (Custom)
function syncFpsModeUI() {
  $('optFpsSource').textContent = `${t('optFpsSource')} (${sourceFps()})`
  // visibility (et non display) : la place du champ reste réservée même masqué, pour
  // que passer en « Personnalisée » ne change pas la taille de la modale
  $('expFps').style.visibility = exp.fpsMode === 'custom' ? 'visible' : 'hidden'
}

// dispose vidéo + bande à partir de la position (haut/bas) et de la fraction de
// hauteur de la bande ; la vidéo est centrée (letterbox) dans la zone restante
function layoutExport() {
  const W = outW()
  const H = outH()
  const ar0 = (video.videoWidth || 16) / (video.videoHeight || 9)
  if (exp.bandPos === 'none') {
    // pas de bande : la vidéo occupe tout le cadre (letterbox centré)
    let vw = W
    let vh = vw / ar0
    if (vh > H) { vh = H; vw = vh * ar0 }
    exp.layout = {
      video: { x: (W - vw) / 2, y: (H - vh) / 2, w: vw, h: vh },
      band: { x: 0, y: 0, w: W, h: 0 },
    }
    return
  }
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

// résumé affiché sur le bouton d'un menu à cases
function summarizeChecks(state, items, allLabel, someLabel) {
  if (!items.length) return allLabel
  if (state.size >= items.length) return allLabel
  if (state.size === 1) { const it = items.find((i) => state.has(i.value)); return it ? it.label : someLabel(1) }
  return someLabel(state.size)
}

// remplit un menu déroulant de cases liées à un Set d'état
function fillChecklist(menu, items, state, onChange) {
  menu.innerHTML = ''
  for (const it of items) {
    const lab = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'; cb.checked = state.has(it.value)
    cb.addEventListener('change', () => { cb.checked ? state.add(it.value) : state.delete(it.value); onChange() })
    lab.append(cb, document.createTextNode(it.label))
    menu.appendChild(lab)
  }
}

// construit les contrôles du groupe « Contenu » à l'ouverture de l'export
function buildExportContent() {
  // pistes rythmo — toutes cochées par défaut
  const trackItems = Array.from({ length: laneCount() }, (_, i) => ({ value: i, label: t('track', i + 1) }))
  exp.tracks = new Set(trackItems.map((it) => it.value))
  const updTracks = () => { $('ddTracksBtn').textContent = summarizeChecks(exp.tracks, trackItems, t('expAllTracks'), t('expSomeTracks')) }
  fillChecklist($('ddTracksMenu'), trackItems, exp.tracks, updTracks)
  updTracks()

  // boucles — toutes cochées = toute la vidéo
  const loopItems = sortedLoops().map((lp) => ({ value: lp.id, label: lp.name + (lp.type === 'out' ? ' (OUT)' : '') }))
  exp.loopSel = new Set(loopItems.map((it) => it.value))
  const updLoops = () => { $('ddLoopsBtn').textContent = loopItems.length ? summarizeChecks(exp.loopSel, loopItems, t('expAllLoops'), t('expSomeLoops')) : t('expWholeVideo') }
  fillChecklist($('ddLoopsMenu'), loopItems, exp.loopSel, updLoops)
  $('ddLoopsBtn').disabled = !loopItems.length
  updLoops()

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
  const def = audioById(project.activeAudioId) || tracks.find((a) => a.type === 'embedded') || tracks[0]
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
  $('expFpsMode').value = exp.fpsMode
  $('expFps').value = effectiveExportFps()
  syncFpsModeUI()
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
$('expFpsMode').addEventListener('change', () => {
  exp.fpsMode = $('expFpsMode').value
  // au passage en Custom, pré-remplir le champ avec la cadence courante (point de départ pratique)
  if (exp.fpsMode === 'custom') $('expFps').value = effectiveExportFps()
  syncFpsModeUI()
})
$('expTheme').addEventListener('change', () => { exp.theme = $('expTheme').value === 'light' ? 'light' : 'dark' })
$('expAudio').addEventListener('change', () => { exp.audioId = $('expAudio').value })

// menus déroulants à cases (pistes / boucles) : ouverture exclusive + fermeture au clic dehors
function closeDropdowns(except) {
  for (const m of [$('ddTracksMenu'), $('ddLoopsMenu')]) if (m !== except) m.classList.add('hidden')
}
function wireDropdown(btnId, menuId) {
  $(btnId).addEventListener('click', (e) => {
    e.stopPropagation()
    const menu = $(menuId)
    const willOpen = menu.classList.contains('hidden')
    closeDropdowns(willOpen ? menu : null)
    menu.classList.toggle('hidden', !willOpen)
  })
  $(menuId).addEventListener('click', (e) => e.stopPropagation())
}
wireDropdown('ddTracksBtn', 'ddTracksMenu')
wireDropdown('ddLoopsBtn', 'ddLoopsMenu')
document.addEventListener('click', () => closeDropdowns(null))

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
  const v = $('expBandPos').value
  exp.bandPos = v === 'top' || v === 'none' ? v : 'bottom'
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
  if (exp.bandPos !== 'none') {
    expCtx.save()
    expCtx.translate(L.band.x * s, L.band.y * s)
    expCtx.beginPath()
    expCtx.rect(0, 0, L.band.w * s, L.band.h * s)
    expCtx.clip()
    const previewTrackList = exp.tracks ? [...exp.tracks].sort((a, b) => a - b) : null
    renderBand(expCtx, now, L.band.w * s, L.band.h * s, (L.band.w * s) / winSec, { ruler: false, wave: false, handles: false, theme: BAND_THEMES[exp.theme || 'dark'], trackList: previewTrackList })
    expCtx.restore()
  }

  // barre de séparation glissable entre la vidéo et la bande (masquée pendant l'export)
  if (!exp.running && exp.bandPos !== 'none') {
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
  if (exp.bandPos === 'none') return false
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
  const fps = effectiveExportFps()
  const winSec = Math.max(1, exp.winSec)
  const L = JSON.parse(JSON.stringify(exp.layout))
  // groupe « Contenu » : plage temporelle (boucles), pistes rythmo et piste audio
  const range = exportRange()
  let startT = range.start
  let dur = range.end - range.start
  if (exp.maxSeconds > 0) dur = Math.min(exp.maxSeconds, dur)
  const total = Math.ceil(dur * fps)
  const trackList = [...(exp.tracks || [])].sort((a, b) => a - b) // pistes rythmo incluses (compactées)

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
  // enregistrements actifs des pistes perso non coupées, calés sur la fenêtre d'export
  const takes = []
  const recMutedSet = project.recMuted || []
  for (const r of (project.recordings || [])) {
    if (!r.active || recMutedSet.includes(r.characterId)) continue
    const eff = recEffDur(r)
    if (!eff || r.startTime + eff <= startT) continue // entièrement avant la fenêtre
    takes.push({ name: recPlayFile(r), offset: Math.max(0, r.startTime - startT), trimStart: r.trimStart || 0, trimDur: eff })
  }
  const noBand = exp.bandPos === 'none'
  const r = await window.api.exportStart({
    fps, W, H, duration: dur, startTime: startT, layout: L, bandW: bw, bandH: bh,
    videoPath: project.videoPath, outPath, audio, takes, projectPath, noBand,
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
  // « Aucune » : pas de bande à envoyer, ffmpeg encode seul (aucune entrée pipe)
  for (let i = 0; !noBand && i < total; i++) {
    if (exp.cancelled) { ok = false; break }
    const tt = startT + i / fps
    renderBand(octx, tt, bw, bh, bw / winSec, { ruler: false, wave: false, handles: false, theme: BAND_THEMES[exp.theme || 'dark'], trackList })
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

// ============================================================ mode lecture (plein écran)
// Aperçu immersif « comme à l'export » : vidéo + bande incrustée (sans forme d'onde) ;
// contrôles auto-masqués (lecture, scène préc./suiv., boucle de scène, affichage des
// pistes, son). F5 pour entrer, Échap pour quitter.
// winSec = secondes visibles sur la bande du mode lecture (zoom propre, plus serré que
// l'éditeur par défaut pour une meilleure lisibilité), réglable par un curseur dédié.
const PLR_SEC_MIN = 2.25, PLR_SEC_MAX = 4 // milieu du slider = √(2.25×4) = 3 s (= défaut winSec)
const player = { open: false, bandFrac: 0.16, bandPos: 'bottom', loopScene: false, hideTimer: null, winSec: 3 }
let playerTracks = new Set()
const pcanvas = $('playerCanvas')
const pctx = pcanvas.getContext('2d')

// synchronise la résolution interne du canvas sur sa taille AFFICHÉE (clientWidth/Height) :
// indispensable car le plein écran OS redimensionne la fenêtre après l'ouverture du mode.
function resizePlayerCanvas() {
  const dpr = window.devicePixelRatio || 1
  const w = pcanvas.clientWidth, h = pcanvas.clientHeight
  if (!w || !h) return
  if (pcanvas.width !== Math.round(w * dpr) || pcanvas.height !== Math.round(h * dpr)) {
    pcanvas.width = Math.round(w * dpr); pcanvas.height = Math.round(h * dpr)
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}
window.addEventListener('resize', () => { if (player.open) resizePlayerCanvas() })

// disposition vidéo (letterbox) + bande, à la manière de l'export — basée sur la taille
// réelle affichée du canvas
function playerLayout() {
  const W = pcanvas.clientWidth, H = pcanvas.clientHeight
  const bandH = clamp(Math.round(H * player.bandFrac), 48, Math.round(H * 0.4))
  const regionH = H - bandH
  const ar = (video.videoWidth || 16) / (video.videoHeight || 9)
  let vw = W, vh = vw / ar
  if (vh > regionH) { vh = regionH; vw = vh * ar }
  const regionY = player.bandPos === 'top' ? bandH : 0
  const bandY = player.bandPos === 'top' ? 0 : regionH
  return { video: { x: (W - vw) / 2, y: regionY + (regionH - vh) / 2, w: vw, h: vh }, band: { x: 0, y: bandY, w: W, h: bandH } }
}

function drawPlayer() {
  resizePlayerCanvas() // garde le canvas calé sur la taille affichée (entrée/sortie plein écran)
  const W = pcanvas.clientWidth, H = pcanvas.clientHeight
  pctx.fillStyle = '#000'; pctx.fillRect(0, 0, W, H)
  const L = playerLayout()
  // remonte la barre de contrôles juste au-dessus de la bande rythmo (bande en bas) pour ne pas la masquer
  const bh = player.bandPos === 'bottom' ? L.band.h : 0
  if (player._pcBandH !== bh) { player._pcBandH = bh; $('playerControls').style.setProperty('--pc-band-h', bh + 'px') }
  if (video.videoWidth) pctx.drawImage(video, L.video.x, L.video.y, L.video.w, L.video.h)
  const winSec = clamp(player.winSec, PLR_SEC_MIN, PLR_SEC_MAX)
  pctx.save()
  pctx.translate(L.band.x, L.band.y)
  pctx.beginPath(); pctx.rect(0, 0, L.band.w, L.band.h); pctx.clip()
  renderBand(pctx, effectiveTime(), L.band.w, L.band.h, L.band.w / winSec, { ruler: false, wave: false, handles: false, theme: bandPal(), trackList: [...playerTracks].sort((a, b) => a - b) })
  pctx.restore()
  drawCues(pctx, L.video, effectiveTime()) // repères ADR sur l'image
}

// scène (boucle) contenant le point de lecture courant
function currentScene() {
  const now = effectiveTime()
  return (project.loops || []).find((lp) => now >= lp.start && now < lp.end) || null
}

function buildPlayerTrackToggles() {
  const wrap = $('pcTracks')
  wrap.innerHTML = ''
  const n = laneCount()
  wrap.style.display = n > 1 ? 'flex' : 'none'
  if (n <= 1) return
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button')
    b.className = 'pc-btn pc-tk' + (playerTracks.has(i) ? ' on' : '')
    b.textContent = String(i + 1)
    b.title = t('track', i + 1)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      playerTracks.has(i) ? playerTracks.delete(i) : playerTracks.add(i)
      b.classList.toggle('on')
      showPlayerControls()
    })
    wrap.appendChild(b)
  }
}

function showPlayerControls() {
  $('playerControls').classList.add('show')
  $('playerMode').classList.remove('cursor-hidden')
  clearTimeout(player.hideTimer)
  player.hideTimer = setTimeout(() => {
    if (player.open && !video.paused) {
      $('playerControls').classList.remove('show')
      $('playerMode').classList.add('cursor-hidden')
    }
  }, 2600)
}

function updatePlayerUI() {
  $('pcPlay').classList.toggle('playing', !video.paused)
  $('pcLoop').classList.toggle('on', player.loopScene)
  $('pcMute').classList.toggle('muted', video.muted)
  const dur = isFinite(video.duration) ? video.duration : 0
  const now = effectiveTime()
  if (document.activeElement !== $('pcSeek')) $('pcSeek').value = String(dur ? Math.round((now / dur) * 1000) : 0)
  $('pcTime').textContent = `${formatTcShort(now)} / ${formatTcShort(dur)}`
  const sc = currentScene()
  $('pcScene').textContent = sc ? (sc.type === 'out' ? 'OUT · ' : '') + sc.name : ''
}

function openPlayer() {
  if (detachedOpenFlag) return // aperçu local indisponible tant que la fenêtre détachée est ouverte
  if (!project.videoPath || !video.videoWidth) { toast(t('loadVideoFirst')); return }
  player.open = true
  hideSubOverlay() // l'overlay sous-titres reste réservé à l'aperçu éditeur
  playerTracks = new Set(Array.from({ length: laneCount() }, (_, i) => i))
  buildPlayerTrackToggles()
  syncPlayerZoom()
  $('playerMode').classList.remove('hidden')
  resizePlayerCanvas()
  updatePlayerUI()
  showPlayerControls()
  $('playerMode').requestFullscreen?.().catch(() => {})
}

function closePlayer() {
  if (!player.open) return
  player.open = false
  clearTimeout(player.hideTimer)
  $('playerMode').classList.add('hidden')
  $('playerMode').classList.remove('cursor-hidden')
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
}

$('btnPlayer').addEventListener('click', openPlayer)
$('pcExit').addEventListener('click', closePlayer)

// ============================================================ fenêtre détachée (2e écran)
// La fenêtre principale est maîtresse : elle envoie l'état (projet + source vidéo +
// réglages du player) et la synchro de lecture ; la fenêtre détachée suit, muette.
let detachedOpenFlag = false
let detachedStateTimer = 0
function detachedState() {
  return {
    kind: 'state',
    project: JSON.parse(projectJson()),
    src: video.currentSrc || video.src || null,
    winSec: player.winSec, bandFrac: player.bandFrac, bandPos: player.bandPos,
    tracks: [...playerTracks],
  }
}
function detachedSendState() { if (detachedOpenFlag) window.api.detachedSend(detachedState()) }
// état renvoyé (throttlé) à chaque modification du projet → la bande suit l'édition
function detachedQueueState() {
  if (!detachedOpenFlag || DETACHED || detachedStateTimer) return
  detachedStateTimer = setTimeout(() => { detachedStateTimer = 0; detachedSendState() }, 800)
}
function detachedSync() {
  if (detachedOpenFlag) window.api.detachedSend({ kind: 'sync', t: effectiveTime(), paused: video.paused, rate: video.playbackRate })
}
function updateDetachedUI() {
  $('btnPlayer').disabled = detachedOpenFlag // l'aperçu plein écran local est grisé tant que la fenêtre est ouverte
}
function openDetached() {
  if (!project.videoPath || !video.videoWidth) { toast(t('loadVideoFirst')); return }
  closePlayer()
  window.api.detachedOpen()
}
if (!DETACHED) {
  window.api.onDetachedReady(() => { detachedOpenFlag = true; updateDetachedUI(); detachedSendState(); detachedSync() })
  window.api.onDetachedClosed(() => { detachedOpenFlag = false; updateDetachedUI() })
  video.addEventListener('play', detachedSync)
  video.addEventListener('pause', detachedSync)
  video.addEventListener('seeked', detachedSync)
  video.addEventListener('ratechange', detachedSync)
  $('pcDetach').addEventListener('click', (e) => { e.stopPropagation(); openDetached() })
}

// ---- côté fenêtre détachée : rendu seul, piloté par les messages de la principale ----
async function handleDetachedMsg(m) {
  if (!m) return
  if (m.kind === 'state') {
    if (m.winSec) player.winSec = m.winSec
    if (m.bandFrac) player.bandFrac = m.bandFrac
    if (m.bandPos) player.bandPos = m.bandPos
    if (m.tracks) playerTracks = new Set(m.tracks)
    if (m.project) await loadProjectData(m.project, null)
    if (m.src && video.src !== m.src) video.src = m.src
    applyVolume() // muette (le son sort de la fenêtre principale)
  } else if (m.kind === 'sync') {
    if (video.src && Math.abs(video.currentTime - m.t) > 0.1) { try { video.currentTime = m.t } catch {} }
    if (video.playbackRate !== m.rate) video.playbackRate = m.rate
    if (m.paused && !video.paused) video.pause()
    else if (!m.paused && video.paused) video.play().catch(() => {})
  }
}
if (DETACHED) {
  document.body.classList.add('detached')
  player.open = true
  $('playerMode').classList.remove('hidden')
  // F11 = plein écran sur l'écran de la fenêtre ; Échap = sortir du plein écran / fermer ;
  // tout autre raccourci de l'appli est neutralisé (la principale garde le contrôle)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); window.api.detachedToggleFullscreen() }
    else if (e.key === 'Escape') { window.close() }
    e.stopImmediatePropagation()
  }, true)
  window.api.onDetachedMsg(handleDetachedMsg)
  window.api.detachedReadySignal()
}
$('pcPlay').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); showPlayerControls() })
$('pcPrev').addEventListener('click', (e) => { e.stopPropagation(); gotoLoop(-1); showPlayerControls() })
$('pcNext').addEventListener('click', (e) => { e.stopPropagation(); gotoLoop(1); showPlayerControls() })
$('pcLoop').addEventListener('click', (e) => { e.stopPropagation(); player.loopScene = !player.loopScene; updatePlayerUI(); showPlayerControls() })
$('pcMute').addEventListener('click', (e) => { e.stopPropagation(); video.muted = !video.muted; updatePlayerUI(); showPlayerControls() })
$('pcSeek').addEventListener('input', () => {
  const dur = isFinite(video.duration) ? video.duration : 0
  if (dur) scrubTo((Number($('pcSeek').value) / 1000) * dur)
})
$('pcZoom').addEventListener('input', () => {
  player.winSec = PLR_SEC_MAX * Math.pow(PLR_SEC_MIN / PLR_SEC_MAX, Number($('pcZoom').value))
  showPlayerControls()
})
function syncPlayerZoom() {
  $('pcZoom').value = String(Math.log(player.winSec / PLR_SEC_MAX) / Math.log(PLR_SEC_MIN / PLR_SEC_MAX))
}
$('playerCanvas').addEventListener('click', () => { togglePlay(); showPlayerControls() })
$('playerMode').addEventListener('mousemove', showPlayerControls)
// quitter le plein écran (Échap navigateur) ferme aussi le mode lecture
document.addEventListener('fullscreenchange', () => { if (player.open && !document.fullscreenElement) closePlayer() })

// ============================================================ main loop
let loopN = 0
function loop() {
  loopN++
  if (detachedOpenFlag && loopN % 15 === 0) detachedSync() // synchro périodique (~4 Hz)
  $('timecode').textContent = formatTc(effectiveTime(), project.fps)
  btnPlay.classList.toggle('playing', !video.paused)
  drawSeekBar()
  syncTakesMonitor()
  if (dub.on) dubSync(false) // fondu voix/sans-voix suivi finement (bornes de répliques)
  if (player.open) {
    // boucle de scène : revenir au début quand on atteint la fin de la scène courante
    if (player.loopScene && !video.paused) {
      const sc = currentScene()
      if (sc && effectiveTime() >= sc.end - 0.03) video.currentTime = sc.start
    }
    drawPlayer()
    updatePlayerUI()
  } else {
    if (activeTab === 'tracks') drawTracks()
    else if (activeTab === 'rec') { drawRecBand(); drawRecClips() }
    else draw()
    drawCuesEditor() // overlay des repères ADR sur la vidéo de l'éditeur
  }
  requestAnimationFrame(loop)
}

// ============================================================ init
// Les réglages persistants (settings.ini) sont chargés depuis le process
// principal — qui a déjà construit le menu avec les mêmes valeurs.
;(async () => {
  const st = await window.api.getSettings()
  try { const ac = await window.api.audioConfigGet(); if (ac) { audioCfg.api = ac.api || 'system'; audioCfg.device = ac.device || null; audioCfg.deviceLabel = ac.deviceLabel || null; audioCfg.output = ac.output || null; audioCfg.outputLabel = ac.outputLabel || null; audioCfg.recOffsetMs = Number(ac.recOffsetMs) || 0 } } catch {}
  applyOutputSink()
  if (!DETACHED) preloadSettings() // débloque les noms de périphériques + précharge les listes (Paramètres instantanés)
  lang = ['en', 'es'].includes(st.lang) ? st.lang : 'fr'
  autosaveOn = !!st.autosave
  autofocusText = st.autofocus !== false
  showSeekBar = st.seekbar !== false
  applySeekBarVisibility()
  showWave = st.wave !== false
  showVideoInfo = !!st.info
  showSubs = !!st.subs
  exportEncoder = st.encoder === 'cpu' ? 'cpu' : 'gpu'
  discordOn = !!st.discord
  setTheme(st.theme)
  addCharacter()
  undoStack = []
  redoStack = []
  syncUndoMenu()
  setClean()
  loadBundledFonts() // décode les polices libres embarquées pour le rendu canvas
  applyLang()
  applyBandHeight() // hauteur de bande = nb de pistes × hauteur de piste fixe
  updateDiscordActivity()
  requestAnimationFrame(loop)
})()
