'use strict'
const { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const net = require('net')
const crypto = require('crypto')
const { pathToFileURL } = require('url')

let ffmpegPath = null
try {
  ffmpegPath = require('ffmpeg-static')
} catch {}

// horodatage de build généré par scripts/make-buildinfo.js au packaging
let buildInfo = null
try {
  buildInfo = require('./build-info.json')
} catch {}
const versionLine = () => `Version ${app.getVersion()}${buildInfo?.builtAt ? ` — build ${buildInfo.builtAt}` : ' (dev)'}`

let win = null

// ---------- détection de mise à jour (GitHub releases, silencieuse) ----------
const REPO_URL = 'https://github.com/fusorf/LibreRythmo'
let latestVersion = null // ex. '1.1.0' si plus récente que l'app, sinon null

function cmpVer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

// check au démarrage : pas de popup, pas d'erreur visible si hors-ligne ;
// si une version plus récente existe, le renderer affiche un toast cliquable
async function checkForUpdate() {
  try {
    const res = await fetch('https://api.github.com/repos/fusorf/LibreRythmo/releases/latest', {
      headers: { 'User-Agent': 'LibreRythmo' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return
    const tag = String((await res.json()).tag_name || '').replace(/^v/, '')
    if (/^\d+\.\d+\.\d+$/.test(tag) && cmpVer(tag, app.getVersion()) > 0) {
      latestVersion = tag
      if (win && !win.isDestroyed()) win.webContents.send('update-available', tag)
    }
  } catch {} // hors-ligne / API limitée : silencieux
}

ipcMain.handle('open-releases', () => shell.openExternal(`${REPO_URL}/releases/latest`))

// ---------- réglages persistants — settings.ini dans le dossier userData ----------
const DEFAULTS = { lang: 'fr', theme: 'dark', autosave: false, wave: true, info: false, subs: false, encoder: 'gpu', discord: true, autofocus: true, seekbar: true }
let settings = { ...DEFAULTS, recent: [] }

const settingsPath = () => path.join(app.getPath('userData'), 'settings.ini')

function loadSettings() {
  try {
    const txt = fs.readFileSync(settingsPath(), 'utf8')
    let sec = ''
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith(';') || line.startsWith('#')) continue
      const m = line.match(/^\[(.+)\]$/)
      if (m) { sec = m[1].toLowerCase(); continue }
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      if (sec === 'ui') {
        if (k === 'lang' && ['fr', 'en'].includes(v)) settings.lang = v
        else if (k === 'theme' && ['dark', 'light'].includes(v)) settings.theme = v
        else if (k === 'autosave') settings.autosave = v === '1'
        else if (k === 'wave') settings.wave = v === '1'
        else if (k === 'info') settings.info = v === '1'
        else if (k === 'subs') settings.subs = v === '1'
        else if (k === 'discord') settings.discord = v === '1'
        else if (k === 'autofocus') settings.autofocus = v === '1'
        else if (k === 'seekbar') settings.seekbar = v === '1'
      } else if (sec === 'export') {
        if (k === 'encoder' && ['gpu', 'cpu'].includes(v)) settings.encoder = v
      } else if (sec === 'recent') {
        if (v && !settings.recent.includes(v)) settings.recent.push(v)
      }
    }
    settings.recent = settings.recent.slice(0, 8)
  } catch {} // pas de fichier = valeurs par défaut
}

function saveSettings() {
  const b = (x) => (x ? '1' : '0')
  const out = [
    '; LibreRythmo — réglages (généré automatiquement)',
    '[ui]',
    `lang=${settings.lang}`,
    `theme=${settings.theme}`,
    `autosave=${b(settings.autosave)}`,
    `wave=${b(settings.wave)}`,
    `info=${b(settings.info)}`,
    `subs=${b(settings.subs)}`,
    `discord=${b(settings.discord)}`,
    `autofocus=${b(settings.autofocus)}`,
    `seekbar=${b(settings.seekbar)}`,
    '',
    '[export]',
    `encoder=${settings.encoder}`,
    '',
    '[recent]',
    ...settings.recent.map((p, i) => `${i + 1}=${p}`),
    '',
  ]
  try { fs.writeFileSync(settingsPath(), out.join('\r\n'), 'utf8') } catch {}
}

function addRecent(p) {
  settings.recent = [p, ...settings.recent.filter((x) => x !== p)].slice(0, 8)
  saveSettings()
  buildMenu()
}

ipcMain.handle('get-settings', () => settings)

// ---------- Discord Rich Presence (IPC local, sans dépendance) ----------
// Pour afficher la présence, créer une application sur https://discord.com/developers
// et coller son « Application ID » ci-dessous (sinon la connexion est refusée en silence).
const DISCORD_CLIENT_ID = '1517161433857527899' // Application ID Discord (LibreRythmo)
const discordStart = Date.now()
let discordSock = null
let discordReady = false
let discordActivity = null // { details, state } poussé par le renderer

function discordPipe(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
  return path.join(base, `discord-ipc-${i}`)
}
function discordFrame(op, data) {
  const json = Buffer.from(JSON.stringify(data))
  const buf = Buffer.alloc(8 + json.length)
  buf.writeInt32LE(op, 0)
  buf.writeInt32LE(json.length, 4)
  json.copy(buf, 8)
  return buf
}
function discordConnect(i = 0) {
  // pas d'Application ID valide renseigné → on ne tente rien (présence inactive)
  if (discordSock || i > 9 || !/^[1-9]\d{16,19}$/.test(DISCORD_CLIENT_ID)) return
  const sock = net.createConnection(discordPipe(i))
  sock.on('connect', () => {
    discordSock = sock
    sock.write(discordFrame(0, { v: 1, client_id: DISCORD_CLIENT_ID })) // handshake
  })
  sock.on('data', (buf) => {
    try {
      const len = buf.readInt32LE(4)
      const msg = JSON.parse(buf.slice(8, 8 + len).toString())
      if (msg.evt === 'READY') { discordReady = true; discordPush() }
    } catch {}
  })
  sock.on('error', () => { sock.destroy(); if (!discordSock) discordConnect(i + 1) })
  sock.on('close', () => { if (sock === discordSock) { discordSock = null; discordReady = false } })
}
function discordDisconnect() {
  discordReady = false
  if (discordSock) {
    try { discordSock.write(discordFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: String(discordStart) })) } catch {}
    try { discordSock.destroy() } catch {}
    discordSock = null
  }
}
function discordPush() {
  if (!discordSock || !discordReady) return
  const a = discordActivity || {}
  const activity = {
    details: a.details || 'Bande rythmo',
    state: a.state || undefined,
    timestamps: { start: discordStart },
    assets: { large_image: 'logo', large_text: 'LibreRythmo' },
  }
  try {
    discordSock.write(discordFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: `${discordStart}-${Math.random()}` }))
  } catch {}
}
function discordSet(enabled) {
  if (enabled) discordConnect()
  else discordDisconnect()
}
ipcMain.handle('discord-activity', (e, a) => { discordActivity = a || null; discordPush() })

// la barre de menus native + les menus déroulants suivent le thème de l'app
function applyNativeTheme() {
  nativeTheme.themeSource = settings.theme === 'light' ? 'light' : 'dark'
}

function createWindow() {
  applyNativeTheme()
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: settings.theme === 'light' ? '#efeae0' : '#15161a',
    title: 'LibreRythmo',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  buildMenu()
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  setTimeout(checkForUpdate, 3000) // après le démarrage, sans le ralentir

  // confirmation si le projet a des modifications non enregistrées
  win.on('close', (e) => {
    if (!rendererDirty) return
    const s = S()
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: s.confirmQuitTitle,
      message: s.confirmQuitMsg,
      detail: s.confirmQuitDetail,
      buttons: [s.btnQuit, s.btnCancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (r !== 0) e.preventDefault()
  })
}

let rendererDirty = false
ipcMain.handle('set-dirty', (e, d) => { rendererDirty = !!d })

// dialogue standard avant d'écraser le projet courant (Fichier → Nouveau projet)
ipcMain.handle('confirm-unsaved', () => {
  const s = S()
  const r = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: s.confirmQuitTitle,
    message: s.confirmQuitMsg,
    detail: s.confirmNewDetail,
    buttons: [s.btnSave, s.btnDontSave, s.btnCancel],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  return r === 0 ? 'save' : r === 1 ? 'discard' : 'cancel'
})

const MENU_STR = {
  fr: {
    file: 'Fichier',
    newProject: 'Nouveau projet',
    openVideo: 'Ouvrir une vidéo…',
    subtitles: 'Sous-titres',
    importSrt: 'Importer (SRT/VTT/ASS)…',
    exportSrt: 'Exporter (SRT)…',
    updateSrt: 'Mettre à jour depuis un SRT corrigé…',
    detx: 'DETX',
    importDetx: 'Importer…',
    importDetxRoles: 'Importer les personnages…',
    exportDetx: 'Exporter…',
    openProject: 'Ouvrir un projet…',
    recentProjects: 'Projets récents',
    noRecent: '(aucun projet récent)',
    saveProject: 'Enregistrer le projet',
    saveProjectAs: 'Enregistrer sous…',
    autosave: 'Enregistrement automatique',
    exportVideo: 'Exporter la vidéo…',
    exportPdf: 'Exporter le script (PDF)…',
    workDocs: 'Documents de travail (PDF)',
    docPresence: 'Grille de présence…',
    docTally: 'Relevé de lignes…',
    transcribe: 'Transcription assistée (expérimental)…',
    quit: 'Quitter',
    edit: 'Édition',
    undo: 'Annuler',
    redo: 'Rétablir',
    view: 'Affichage',
    autofocusText: 'Autofocus du texte',
    seekbar: 'Barre de progression',
    wave: "Forme d'onde audio",
    videoInfo: 'Infos vidéo',
    subs: 'Sous-titres',
    lightMode: 'Mode clair',
    discord: 'Discord Rich Presence',
    clearProxies: 'Vider le cache vidéo',
    settings: 'Paramètres…',
    language: 'Langue',
    fullscreen: 'Plein écran',
    help: 'Aide',
    guide: 'Guide',
    about: 'À propos',
    aboutDetail: 'Bande rythmo libre pour le doublage.\n\n{version}\n© 2026 fusorf — licence GPL-3.0-or-later\n\nConstruit avec :\n•  Electron (MIT) — electronjs.org\n•  FFmpeg (GPL v3, binaire embarqué via ffmpeg-static) — ffmpeg.org\n•  Chromium & Node.js, embarqués par Electron\n\nLe code source de LibreRythmo est libre (GPL v3).\nLe binaire FFmpeg embarqué reste sous sa propre licence (GPL v3) ; il est appelé comme programme externe.',
    confirmQuitTitle: 'Modifications non enregistrées',
    confirmQuitMsg: 'Le projet contient des modifications non enregistrées.',
    confirmQuitDetail: 'Quitter sans enregistrer ?',
    btnQuit: 'Quitter sans enregistrer',
    btnCancel: 'Annuler',
    confirmNewDetail: 'Enregistrer les modifications avant de continuer ?',
    btnSave: 'Enregistrer',
    btnDontSave: 'Ne pas enregistrer',
    btnClose: 'Fermer',
    updateAvail: 'Nouvelle version disponible : v{v}',
    dlgSrtSave: 'Exporter les sous-titres',
    dlgVideo: 'Ouvrir une vidéo',
    dlgVideoFilter: 'Vidéo',
    dlgAudio: 'Importer un fichier audio',
    dlgAudioFilter: 'Audio',
    dlgProject: 'Ouvrir un projet',
    dlgProjectFilter: 'Projet rythmo',
    dlgSave: 'Enregistrer le projet',
    dlgSrt: 'Importer des sous-titres SRT',
    dlgSubs: 'Importer des sous-titres',
    dlgSrtFilter: 'Sous-titres',
    dlgFont: 'Charger une police',
    dlgFontFilter: 'Police (TTF/OTF)',
    dlgDetx: 'Importer un DETX',
    dlgDetxSave: 'Exporter en DETX',
    dlgDetxFilter: 'Bande rythmo DETX',
    dlgPdf: 'Exporter le script PDF',
    dlgPdfFilter: 'Document PDF',
    dlgExport: 'Exporter la vidéo',
    dlgExportFilter: 'Vidéo MP4',
  },
  en: {
    file: 'File',
    newProject: 'New project',
    openVideo: 'Open a video…',
    subtitles: 'Subtitles',
    importSrt: 'Import (SRT/VTT/ASS)…',
    exportSrt: 'Export (SRT)…',
    updateSrt: 'Update from corrected SRT…',
    detx: 'DETX',
    importDetx: 'Import…',
    importDetxRoles: 'Import characters…',
    exportDetx: 'Export…',
    openProject: 'Open a project…',
    recentProjects: 'Recent projects',
    noRecent: '(no recent projects)',
    saveProject: 'Save project',
    saveProjectAs: 'Save As…',
    autosave: 'Autosave',
    exportVideo: 'Export video…',
    exportPdf: 'Export script (PDF)…',
    workDocs: 'Work documents (PDF)',
    docPresence: 'Presence grid…',
    docTally: 'Line tally…',
    transcribe: 'Assisted transcription (experimental)…',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    view: 'View',
    autofocusText: 'Text autofocus',
    seekbar: 'Progress bar',
    wave: 'Audio waveform',
    videoInfo: 'Video info',
    subs: 'Subtitles',
    lightMode: 'Light mode',
    discord: 'Discord Rich Presence',
    clearProxies: 'Clear video cache',
    settings: 'Settings…',
    language: 'Language',
    fullscreen: 'Full screen',
    help: 'Help',
    guide: 'Guide',
    about: 'About',
    aboutDetail: 'Free rythmo band for dubbing.\n\n{version}\n© 2026 fusorf — GPL-3.0-or-later license\n\nBuilt with:\n•  Electron (MIT) — electronjs.org\n•  FFmpeg (GPL v3, binary bundled via ffmpeg-static) — ffmpeg.org\n•  Chromium & Node.js, shipped by Electron\n\nLibreRythmo source code is free software (GPL v3).\nThe bundled FFmpeg binary keeps its own license (GPL v3); it is invoked as an external program.',
    confirmQuitTitle: 'Unsaved changes',
    confirmQuitMsg: 'The project has unsaved changes.',
    confirmQuitDetail: 'Quit without saving?',
    btnQuit: 'Quit without saving',
    btnCancel: 'Cancel',
    confirmNewDetail: 'Save changes before continuing?',
    btnSave: 'Save',
    btnDontSave: "Don't save",
    btnClose: 'Close',
    updateAvail: 'New version available: v{v}',
    dlgSrtSave: 'Export subtitles',
    dlgVideo: 'Open a video',
    dlgVideoFilter: 'Video',
    dlgAudio: 'Import an audio file',
    dlgAudioFilter: 'Audio',
    dlgProject: 'Open a project',
    dlgProjectFilter: 'Rythmo project',
    dlgSave: 'Save project',
    dlgSrt: 'Import SRT subtitles',
    dlgSubs: 'Import subtitles',
    dlgSrtFilter: 'Subtitles',
    dlgFont: 'Load a font',
    dlgFontFilter: 'Font (TTF/OTF)',
    dlgDetx: 'Import DETX',
    dlgDetxSave: 'Export DETX',
    dlgDetxFilter: 'DETX rythmo band',
    dlgPdf: 'Export script PDF',
    dlgPdfFilter: 'PDF document',
    dlgExport: 'Export video',
    dlgExportFilter: 'MP4 video',
  },
}
const S = () => MENU_STR[settings.lang]

let undoState = { undo: false, redo: false } // conservé entre les reconstructions du menu
ipcMain.handle('set-undo-state', (e, st) => {
  undoState = { undo: !!st.undo, redo: !!st.redo }
  const m = Menu.getApplicationMenu()
  const u = m?.getMenuItemById('menu-undo')
  const r = m?.getMenuItemById('menu-redo')
  if (u) u.enabled = undoState.undo
  if (r) r.enabled = undoState.redo
})

function buildMenu() {
  const s = S()
  const send = (action, arg) => win.webContents.send('menu', action, arg)
  // sous-menu Projets récents : nom de fichier + dossier parent, chemin complet envoyé au clic
  const recentItems = settings.recent.length
    ? settings.recent.map((p) => ({
        label: p.split(/[\\/]/).slice(-2).join('\\'),
        click: () => send('open-recent', p),
      }))
    : [{ label: s.noRecent, enabled: false }]
  const template = [
    {
      label: s.file,
      submenu: [
        { label: s.newProject, accelerator: 'CmdOrCtrl+N', click: () => send('new-project') },
        { type: 'separator' },
        { label: s.openVideo, accelerator: 'CmdOrCtrl+O', click: () => send('open-video') },
        {
          label: s.subtitles,
          submenu: [
            { label: s.importSrt, click: () => send('import-srt') },
            { label: s.exportSrt, click: () => send('export-srt') },
            { label: s.updateSrt, click: () => send('update-srt') },
          ],
        },
        {
          label: s.detx,
          submenu: [
            { label: s.importDetx, click: () => send('import-detx') },
            { label: s.importDetxRoles, click: () => send('import-detx-roles') },
            { label: s.exportDetx, click: () => send('export-detx') },
          ],
        },
        { type: 'separator' },
        { label: s.openProject, accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-project') },
        { label: s.recentProjects, submenu: recentItems },
        { label: s.saveProject, accelerator: 'CmdOrCtrl+S', click: () => send('save-project') },
        { label: s.saveProjectAs, accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-project-as') },
        { label: s.autosave, type: 'checkbox', checked: settings.autosave, click: (item) => send('toggle-autosave', item.checked) },
        { type: 'separator' },
        { label: s.exportVideo, accelerator: 'CmdOrCtrl+E', click: () => send('export-video') },
        { label: s.exportPdf, click: () => send('export-pdf') },
        {
          label: s.workDocs,
          submenu: [
            { label: s.docPresence, click: () => send('export-presence') },
            { label: s.docTally, click: () => send('export-tally') },
          ],
        },
        { type: 'separator' },
        { label: s.transcribe, click: () => send('transcribe') },
        { type: 'separator' },
        { label: s.quit, role: 'quit' },
      ],
    },
    {
      label: s.edit,
      submenu: [
        // accélérateurs affichés mais non enregistrés : le renderer gère Ctrl+Z/Y
        // lui-même (et laisse l'annulation native des champs texte intacte)
        { id: 'menu-undo', label: s.undo, accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, enabled: undoState.undo, click: () => send('undo') },
        { id: 'menu-redo', label: s.redo, accelerator: 'CmdOrCtrl+Y', registerAccelerator: false, enabled: undoState.redo, click: () => send('redo') },
        { type: 'separator' },
        { label: s.autofocusText, type: 'checkbox', checked: settings.autofocus, click: (item) => send('toggle-autofocus', item.checked) },
      ],
    },
    {
      label: s.view,
      submenu: [
        { label: s.seekbar, type: 'checkbox', checked: settings.seekbar, click: (item) => send('toggle-seekbar', item.checked) },
        { label: s.wave, type: 'checkbox', checked: settings.wave, click: (item) => send('toggle-wave', item.checked) },
        { label: s.videoInfo, type: 'checkbox', checked: settings.info, click: (item) => send('toggle-video-info', item.checked) },
        { label: s.subs, type: 'checkbox', checked: settings.subs, click: (item) => send('toggle-subtitles', item.checked) },
        { label: s.lightMode, type: 'checkbox', checked: settings.theme === 'light', click: (item) => send('toggle-theme', item.checked) },
        { label: s.discord, type: 'checkbox', checked: settings.discord, click: (item) => send('toggle-discord', item.checked) },
        { type: 'separator' },
        { label: s.settings, click: () => send('open-settings') },
        { label: s.clearProxies, click: () => send('clear-proxy-cache') },
        { type: 'separator' },
        {
          label: s.language,
          submenu: [
            { label: 'Français', type: 'checkbox', checked: settings.lang === 'fr', click: () => send('set-lang', 'fr') },
            { label: 'English', type: 'checkbox', checked: settings.lang === 'en', click: () => send('set-lang', 'en') },
          ],
        },
        { type: 'separator' },
        { label: s.fullscreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: s.help,
      submenu: [
        { label: s.guide, accelerator: 'F1', click: () => send('show-guide') },
        { type: 'separator' },
        {
          label: s.about,
          click: async () => {
            const st = S()
            const ver = versionLine() + (latestVersion ? `\n${st.updateAvail.replace('{v}', latestVersion)}` : '')
            const r = await dialog.showMessageBox(win, {
              type: 'none',
              title: 'LibreRythmo',
              message: 'LibreRythmo — by fusorf',
              detail: st.aboutDetail.replace('{version}', ver),
              buttons: [st.btnClose, 'GitHub'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
            if (r.response === 1) shell.openExternal(REPO_URL)
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// le renderer pousse tous ses réglages ici : persistance + reconstruction du menu
ipcMain.handle('set-lang', (e, o) => {
  settings.lang = o.lang === 'en' ? 'en' : 'fr'
  settings.theme = o.theme === 'light' ? 'light' : 'dark'
  settings.wave = !!o.wave
  settings.info = !!o.info
  settings.subs = !!o.subs
  settings.autosave = !!o.autosave
  settings.autofocus = o.autofocus !== false
  settings.seekbar = o.seekbar !== false
  if (['gpu', 'cpu'].includes(o.encoder)) settings.encoder = o.encoder
  if (o.discord !== undefined && !!o.discord !== settings.discord) {
    settings.discord = !!o.discord
    discordSet(settings.discord)
  }
  saveSettings()
  applyNativeTheme()
  buildMenu()
})

app.whenReady().then(() => {
  // langue par défaut : français si l'OS est en français, anglais sinon
  // (écrasée par la valeur de settings.ini si l'utilisateur a déjà choisi)
  settings.lang = app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en'
  loadSettings()
  createWindow()
  if (settings.discord) discordConnect()
})
app.on('window-all-closed', () => app.quit())

ipcMain.handle('open-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgVideo,
    filters: [{ name: S().dlgVideoFilter, extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths.length) return null
  const p = r.filePaths[0]
  return { path: p, url: pathToFileURL(p).href }
})

ipcMain.handle('open-audio', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgAudio,
    filters: [{ name: S().dlgAudioFilter, extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }],
    properties: ['openFile'],
  })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})

ipcMain.handle('file-url', (e, p) => {
  try {
    return p && fs.existsSync(p) ? pathToFileURL(p).href : null
  } catch {
    return null
  }
})

ipcMain.handle('open-project', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgProject,
    filters: [{ name: S().dlgProjectFilter, extensions: ['rythmo', 'json'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths.length) return null
  const p = r.filePaths[0]
  const data = fs.readFileSync(p, 'utf8')
  addRecent(p)
  return { path: p, data }
})

// ouverture directe (menu Projets récents) ; purge l'entrée si le fichier a disparu
ipcMain.handle('open-project-path', (e, p) => {
  try {
    const data = fs.readFileSync(p, 'utf8')
    addRecent(p)
    return { path: p, data }
  } catch {
    settings.recent = settings.recent.filter((x) => x !== p)
    saveSettings()
    buildMenu()
    return null
  }
})

ipcMain.handle('save-project', async (e, json, existingPath) => {
  let p = existingPath
  if (!p) {
    const r = await dialog.showSaveDialog(win, {
      title: S().dlgSave,
      defaultPath: 'projet.rythmo',
      filters: [{ name: S().dlgProjectFilter, extensions: ['rythmo'] }],
    })
    if (r.canceled || !r.filePath) return null
    p = r.filePath
  }
  fs.writeFileSync(p, json, 'utf8')
  if (!existingPath) addRecent(p) // l'autosave répété ne réordonne pas la liste
  else if (!settings.recent.includes(p)) addRecent(p)
  return p
})

// Enregistrer sous… : toujours un dialogue, pré-rempli avec le fichier courant
ipcMain.handle('save-project-as', async (e, json, currentPath) => {
  const r = await dialog.showSaveDialog(win, {
    title: S().dlgSave,
    defaultPath: currentPath || 'projet.rythmo',
    filters: [{ name: S().dlgProjectFilter, extensions: ['rythmo'] }],
  })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, json, 'utf8')
  addRecent(r.filePath)
  return r.filePath
})

ipcMain.handle('file-stat', (e, p) => {
  try {
    return { size: fs.statSync(p).size }
  } catch {
    return null
  }
})

ipcMain.handle('read-file', (e, p) => {
  try {
    return fs.readFileSync(p)
  } catch {
    return null
  }
})

ipcMain.handle('import-srt', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgSrt,
    filters: [{ name: S().dlgSrtFilter, extensions: ['srt'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths.length) return null
  return fs.readFileSync(r.filePaths[0], 'utf8')
})

// import de sous-titres tous formats (SRT / VTT / ASS / SSA) — le renderer détecte
// le format d'après le contenu
ipcMain.handle('import-subs', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgSubs,
    filters: [{ name: S().dlgSrtFilter, extensions: ['srt', 'vtt', 'ass', 'ssa'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths.length) return null
  return fs.readFileSync(r.filePaths[0], 'utf8')
})

ipcMain.handle('export-srt', async (e, content, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    title: S().dlgSrtSave,
    defaultPath: suggested || 'sous-titres.srt',
    filters: [{ name: S().dlgSrtFilter, extensions: ['srt'] }],
  })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, content, 'utf8')
  return r.filePath
})

// sélection d'une police TTF/OTF : renvoie son nom + les octets en base64, embarqués
// dans le projet par le renderer (portabilité + rendu identique à l'export)
ipcMain.handle('pick-font', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgFont,
    filters: [{ name: S().dlgFontFilter, extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths.length) return null
  const p = r.filePaths[0]
  try {
    const data = fs.readFileSync(p).toString('base64')
    const name = path.basename(p).replace(/\.[^.]+$/, '')
    return { name, data, ext: path.extname(p).slice(1).toLowerCase() }
  } catch {
    return null
  }
})

ipcMain.handle('import-detx', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: S().dlgDetx,
    filters: [{ name: S().dlgDetxFilter, extensions: ['detx', 'xml'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths.length) return null
  return { path: r.filePaths[0], data: fs.readFileSync(r.filePaths[0], 'utf8') }
})

ipcMain.handle('export-detx', async (e, content, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    title: S().dlgDetxSave,
    defaultPath: suggested || 'projet.detx',
    filters: [{ name: S().dlgDetxFilter, extensions: ['detx'] }],
  })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, content, 'utf8')
  return r.filePath
})

// PDF : on rend le HTML du script dans une fenêtre hors écran puis printToPDF
ipcMain.handle('export-pdf', async (e, html, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    title: S().dlgPdf,
    defaultPath: suggested || 'script.pdf',
    filters: [{ name: S().dlgPdfFilter, extensions: ['pdf'] }],
  })
  if (r.canceled || !r.filePath) return null
  const tmp = path.join(app.getPath('temp'), `lr-script-${Date.now()}.html`)
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    fs.writeFileSync(tmp, html, 'utf8')
    await pdfWin.loadFile(tmp)
    const data = await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.7, bottom: 0.7, left: 0.8, right: 0.8 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#999;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    })
    fs.writeFileSync(r.filePath, data)
    return r.filePath
  } catch (err) {
    return { error: String((err && err.message) || err) }
  } finally {
    pdfWin.destroy()
    try { fs.unlinkSync(tmp) } catch {}
  }
})

// ---------- export vidéo (bande JPEG → ffmpeg compose + encode GPU) ----------
let exportProc = null
let probedEncoder // h264_nvenc | h264_qsv | h264_amf | libx264

async function probeEncoder() {
  if (probedEncoder) return probedEncoder
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const ok = await new Promise((res) => {
      const p = spawn(ffmpegPath, [
        '-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2',
        '-c:v', enc, '-f', 'null', '-',
      ], { stdio: 'ignore' })
      const to = setTimeout(() => { try { p.kill() } catch {} res(false) }, 5000)
      p.on('close', (c) => { clearTimeout(to); res(c === 0) })
      p.on('error', () => { clearTimeout(to); res(false) })
    })
    if (ok) return (probedEncoder = enc)
  }
  return (probedEncoder = 'libx264')
}

ipcMain.handle('probe-encoder', () => (ffmpegPath ? probeEncoder() : 'libx264'))

// cadence réelle lue dans les métadonnées du flux via ffmpeg (aucune lecture vidéo
// côté renderer → la bande et l'aperçu ne bougent pas). ffmpeg -i écrit les infos
// de flux sur stderr puis sort en erreur (pas de sortie demandée) : on parse stderr.
ipcMain.handle('probe-fps', (e, p) => {
  if (!ffmpegPath || !p) return null
  return new Promise((resolve) => {
    let err = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const m = err.match(/(\d+(?:\.\d+)?)\s*fps/)
      resolve(m ? parseFloat(m[1]) : null)
    }
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', p], { stdio: ['ignore', 'ignore', 'pipe'] })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('close', finish)
    proc.on('error', () => resolve(null))
    setTimeout(() => { try { proc.kill() } catch {} finish() }, 5000)
  })
})

// énumération des pistes audio du conteneur via ffmpeg -i (ffprobe n'est pas fourni
// par ffmpeg-static). On parse les lignes « Stream #x:y(lang): Audio: codec, … » et
// on numérote les pistes audio dans l'ordre (index relatif a:0, a:1, …) pour le mapping.
const CHANNELS = { mono: 1, stereo: 2, '2.1': 3, quad: 4, '3.0': 3, '4.0': 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8, downmix: 2 }
ipcMain.handle('probe-audio-tracks', (e, p) => {
  if (!ffmpegPath || !p) return []
  return new Promise((resolve) => {
    let err = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      const tracks = []
      let ord = 0
      for (const line of err.split(/\r?\n/)) {
        const sm = line.match(/Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\(([^)]+)\))?: Audio:\s*([^\s,]+)/)
        if (!sm) continue
        const lang = sm[2] && sm[2] !== 'und' ? sm[2] : null
        const codec = sm[3]
        let channels = 2
        const cm = line.match(/,\s*(mono|stereo|2\.1|quad|3\.0|4\.0|5\.0|5\.1(?:\(side\))?|6\.1|7\.1|downmix|(\d+) channels)/)
        if (cm) channels = CHANNELS[cm[1].replace('(side)', '')] || (cm[2] ? Number(cm[2]) : 2)
        tracks.push({ index: ord++, lang, codec, channels })
      }
      resolve(tracks)
    }
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', p], { stdio: ['ignore', 'ignore', 'pipe'] })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('close', finish)
    proc.on('error', () => resolve([]))
    setTimeout(() => { try { proc.kill() } catch {} finish() }, 5000)
  })
})

// extrait une piste audio embarquée vers un WAV mono 16 kHz temporaire (léger), pour
// en calculer la forme d'onde côté renderer — Chromium ne décode que la 1re piste d'un
// conteneur multiplexé. Résultat mis en cache (hash chemin+index).
ipcMain.handle('extract-audio-track', (e, videoPath, aIndex) => {
  if (!ffmpegPath || !videoPath) return null
  const key = crypto.createHash('md5').update(`${videoPath}|${aIndex}`).digest('hex').slice(0, 10)
  const out = path.join(app.getPath('temp'), `lr-wave-${key}.wav`)
  try { if (fs.existsSync(out) && fs.statSync(out).size > 0) return out } catch {}
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-y', '-i', videoPath, '-map', `0:a:${aIndex}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-vn', out], { stdio: 'ignore' })
    const done = (ok) => resolve(ok && fs.existsSync(out) ? out : null)
    proc.on('close', (c) => done(c === 0))
    proc.on('error', () => resolve(null))
    setTimeout(() => { try { proc.kill() } catch {} done(false) }, 60000)
  })
})

// extrait une piste audio embarquée en AAC stéréo pleine qualité (m4a temporaire), pour
// la LECTURE : Chromium ne joue que la 1re piste d'un conteneur multiplexé, et le proxy
// ne conserve que celle-là. Résultat mis en cache (hash chemin+index).
ipcMain.handle('extract-audio-play', (e, videoPath, aIndex) => {
  if (!ffmpegPath || !videoPath) return null
  const key = crypto.createHash('md5').update(`${videoPath}|${aIndex}|play`).digest('hex').slice(0, 10)
  const out = path.join(app.getPath('temp'), `lr-play-${key}.m4a`)
  try { if (fs.existsSync(out) && fs.statSync(out).size > 0) return out } catch {}
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-y', '-i', videoPath, '-map', `0:a:${aIndex}`, '-c:a', 'aac', '-b:a', '192k', '-vn', out], { stdio: 'ignore' })
    const done = (ok) => resolve(ok && fs.existsSync(out) ? out : null)
    proc.on('close', (c) => done(c === 0))
    proc.on('error', () => resolve(null))
    setTimeout(() => { try { proc.kill() } catch {} done(false) }, 180000)
  })
})

// ---------- prises voix (S1) : stockage sidecar à côté du projet ----------
// Les prises enregistrées vivent dans un dossier « takes » à côté du .rythmo pour
// rester portables (elles voyagent avec le projet) et ne pas gonfler le JSON. Si le
// projet n'est pas encore enregistré, repli sur le cache portable de l'app.
function takesDir(projectPath) {
  const base = projectPath
    ? path.join(path.dirname(projectPath), 'takes')
    : path.join(appBaseDir(), 'cache', 'takes')
  try { fs.mkdirSync(base, { recursive: true }); return base } catch {}
  const fb = path.join(app.getPath('temp'), 'librerythmo-takes')
  try { fs.mkdirSync(fb, { recursive: true }) } catch {}
  return fb
}
ipcMain.handle('save-take', (e, projectPath, name, buf) => {
  try {
    const p = path.join(takesDir(projectPath), path.basename(name))
    fs.writeFileSync(p, Buffer.from(buf))
    return { ok: true, path: p, name: path.basename(name) }
  } catch (err) { return { error: String((err && err.message) || err) } }
})
ipcMain.handle('take-url', (e, projectPath, name) => {
  try {
    const p = path.join(takesDir(projectPath), path.basename(name))
    if (fs.existsSync(p)) return require('url').pathToFileURL(p).href
  } catch {}
  return null
})
ipcMain.handle('delete-take', (e, projectPath, name) => {
  try { fs.unlinkSync(path.join(takesDir(projectPath), path.basename(name))) } catch {}
  return true
})

// ---------- A4 (expérimental) : transcription assistée via whisper.cpp ----------
// Rien n'est bundlé (cohérence/poids) : le modèle est téléchargé à la demande et le
// moteur whisper.cpp doit être fourni par l'utilisateur (exécutable choisi une fois).
// Le résultat est produit en SRT puis importé par le circuit d'import sous-titres
// existant (déjà éprouvé). Modèles ggml : HuggingFace ggerganov/whisper.cpp.
let whisperProc = null
let whisperAbort = null
function whisperDir() {
  const d = path.join(app.getPath('userData'), 'whisper-models')
  try { fs.mkdirSync(d, { recursive: true }) } catch {}
  return d
}
const whisperCfgPath = () => path.join(app.getPath('userData'), 'whisper.json')
function whisperExeSaved() {
  try { return JSON.parse(fs.readFileSync(whisperCfgPath(), 'utf8')).exe || null } catch { return null }
}
function whisperModelPath(model) {
  return path.join(whisperDir(), `ggml-${String(model).replace(/[^a-z0-9.\-]/gi, '')}.bin`)
}

ipcMain.handle('whisper-status', (e, model) => {
  const mp = whisperModelPath(model)
  let modelOk = false
  try { modelOk = fs.existsSync(mp) && fs.statSync(mp).size > 1e6 } catch {}
  return { model: modelOk, modelPath: mp, exe: whisperExeSaved() }
})

ipcMain.handle('whisper-pick-exe', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'whisper.cpp', properties: ['openFile'] })
  if (r.canceled || !r.filePaths.length) return null
  const exe = r.filePaths[0]
  try { fs.writeFileSync(whisperCfgPath(), JSON.stringify({ exe }), 'utf8') } catch {}
  return exe
})

ipcMain.handle('whisper-download-model', async (e, model) => {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`
  const out = whisperModelPath(model)
  if (fs.existsSync(out) && fs.statSync(out).size > 1e6) return { ok: true, path: out, cached: true }
  const tmp = out + '.part'
  whisperAbort = new AbortController()
  try {
    const res = await fetch(url, { signal: whisperAbort.signal, headers: { 'User-Agent': 'LibreRythmo' } })
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)
    const total = Number(res.headers.get('content-length')) || 0
    const ws = fs.createWriteStream(tmp)
    const reader = res.body.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      ws.write(Buffer.from(value))
      got += value.length
      if (win && !win.isDestroyed()) win.webContents.send('whisper-progress', { phase: 'download', pct: total ? Math.round((got / total) * 100) : 0 })
    }
    await new Promise((r2, rj) => { ws.end(() => r2()); ws.on('error', rj) })
    fs.renameSync(tmp, out)
    whisperAbort = null
    return { ok: true, path: out }
  } catch (err) {
    whisperAbort = null
    try { fs.unlinkSync(tmp) } catch {}
    return { error: String((err && err.message) || err) }
  }
})

ipcMain.handle('whisper-cancel', () => {
  try { if (whisperAbort) whisperAbort.abort() } catch {}
  try { if (whisperProc) whisperProc.kill() } catch {}
  whisperAbort = null; whisperProc = null
  return true
})

ipcMain.handle('whisper-transcribe', async (e, opts) => {
  if (!ffmpegPath) return { error: 'no-ffmpeg' }
  if (whisperProc) return { error: 'busy' }
  const exe = whisperExeSaved()
  if (!exe || !fs.existsSync(exe)) return { error: 'no-engine' }
  const model = whisperModelPath(opts.model)
  if (!fs.existsSync(model)) return { error: 'no-model' }
  const src = opts.source
  if (!src || !fs.existsSync(src)) return { error: 'no-source' }
  // 1) extraction audio 16 kHz mono WAV (format attendu par whisper.cpp)
  const wav = path.join(app.getPath('temp'), `lr-whisper-${Date.now()}.wav`)
  const ok = await new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { stdio: 'ignore' })
    p.on('close', (c) => resolve(c === 0))
    p.on('error', () => resolve(false))
  })
  if (!ok) return { error: 'extract-failed' }
  // 2) exécution du moteur → SRT
  const outBase = path.join(app.getPath('temp'), `lr-whisper-${Date.now()}`)
  const lang = opts.language || 'auto'
  const args = ['-m', model, '-f', wav, '-l', lang, '-osrt', '-of', outBase]
  return await new Promise((resolve) => {
    let tail = ''
    whisperProc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (d) => {
      const s = String(d); tail = (tail + s).slice(-4000)
      const m = s.match(/(\d+)%/)
      if (m && win && !win.isDestroyed()) win.webContents.send('whisper-progress', { phase: 'transcribe', pct: Number(m[1]) })
    }
    whisperProc.stdout.on('data', onData)
    whisperProc.stderr.on('data', onData)
    whisperProc.on('close', (code) => {
      whisperProc = null
      try { fs.unlinkSync(wav) } catch {}
      const srtPath = outBase + '.srt'
      if (code === 0 && fs.existsSync(srtPath)) {
        let srt = ''
        try { srt = fs.readFileSync(srtPath, 'utf8') } catch {}
        try { fs.unlinkSync(srtPath) } catch {}
        resolve({ ok: true, srt })
      } else resolve({ error: tail.slice(-300) || 'transcribe-failed' })
    })
    whisperProc.on('error', () => { whisperProc = null; resolve({ error: 'engine-spawn-failed' }) })
  })
})

// ---------- capture audio : périphérique + backend (WASAPI / DirectShow / ASIO) ----------
// « Système » = capture navigateur (getUserMedia, WASAPI) côté renderer. « DirectSound »
// = capture DirectShow via ffmpeg (atteint les interfaces pro). « ASIO » nécessite un
// ffmpeg compilé avec ASIO (le build inclus ne l'a pas) : l'utilisateur fournit alors
// son propre binaire. Rien n'est bundlé au-delà du ffmpeg déjà présent.
function audioCfgPath() { return path.join(app.getPath('userData'), 'audio-config.json') }
function readAudioCfg() { try { return JSON.parse(fs.readFileSync(audioCfgPath(), 'utf8')) } catch { return {} } }
ipcMain.handle('pick-executable', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] })
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})
ipcMain.handle('audio-config-get', () => readAudioCfg())
ipcMain.handle('audio-config-set', (e, cfg) => { try { fs.writeFileSync(audioCfgPath(), JSON.stringify(cfg || {}), 'utf8') } catch {} return true })

function parseDshowDevices(txt) {
  const out = []
  const re = /"([^"]+)"\s*\(audio\)/g
  let m
  while ((m = re.exec(txt))) out.push(m[1])
  return out
}
ipcMain.handle('list-capture-devices', async (e, api, ffOverride) => {
  const ff = api === 'asio' && ffOverride ? ffOverride : ffmpegPath
  if (!ff) return { devices: [], available: false, error: 'no-ffmpeg' }
  const fmt = api === 'asio' ? 'asio' : 'dshow'
  return await new Promise((resolve) => {
    let buf = ''
    let p
    try { p = spawn(ff, ['-hide_banner', '-f', fmt, '-list_devices', 'true', '-i', 'dummy'], { stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { return resolve({ devices: [], available: false, error: 'spawn' }) }
    const on = (d) => (buf += String(d))
    p.stdout.on('data', on); p.stderr.on('data', on)
    p.on('close', () => {
      if (/Unknown input format|not (?:found|available)/i.test(buf) && !/\(audio\)/.test(buf)) resolve({ devices: [], available: false, error: 'no-backend' })
      else resolve({ devices: parseDshowDevices(buf), available: true })
    })
    p.on('error', () => resolve({ devices: [], available: false, error: 'spawn' }))
    setTimeout(() => { try { p.kill() } catch {} }, 8000)
  })
})

let captureProc = null
let captureDone = null
ipcMain.handle('capture-start', (e, opts) => {
  if (captureProc) return { error: 'busy' }
  const api = opts.api
  const ff = api === 'asio' && opts.ffmpeg ? opts.ffmpeg : ffmpegPath
  if (!ff) return { error: 'no-ffmpeg' }
  if (!opts.device) return { error: 'no-device' }
  const name = path.basename(opts.name || `take_${Date.now()}.wav`)
  const out = path.join(takesDir(opts.projectPath), name)
  const fmt = api === 'asio' ? 'asio' : 'dshow'
  const input = api === 'asio' ? opts.device : `audio=${opts.device}`
  const args = ['-y', '-f', fmt, '-i', input, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out]
  try { captureProc = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] }) }
  catch (err) { captureProc = null; return { error: String((err && err.message) || err) } }
  captureProc.on('close', () => { if (captureDone) { const d = captureDone; captureDone = null; d({ ok: true, name, path: out }) } captureProc = null })
  captureProc.on('error', () => { if (captureDone) { const d = captureDone; captureDone = null; d({ error: 'spawn' }) } captureProc = null })
  captureProc.stdin.on('error', () => {})
  return { ok: true, name }
})
ipcMain.handle('capture-stop', () => {
  if (!captureProc) return { error: 'not-recording' }
  return new Promise((resolve) => {
    captureDone = resolve
    try { captureProc.stdin.write('q') } catch {}
    setTimeout(() => { try { if (captureProc) captureProc.kill('SIGINT') } catch {} }, 600)
  })
})

// ---------- gestion des modèles whisper (installation optionnelle depuis l'UI) ----------
const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
ipcMain.handle('whisper-list-models', () => WHISPER_MODELS.map((m) => {
  const p = whisperModelPath(m)
  let sizeMB = 0, present = false
  try { const st = fs.statSync(p); if (st.size > 1e6) { present = true; sizeMB = Math.round(st.size / 1e6) } } catch {}
  return { model: m, present, sizeMB }
}))
ipcMain.handle('whisper-delete-model', (e, m) => { try { fs.unlinkSync(whisperModelPath(m)) } catch {} return true })
ipcMain.handle('whisper-clear-exe', () => { try { fs.unlinkSync(whisperCfgPath()) } catch {} return true })

// ---------- séparation de voix (IA) : retirer les voix d'une piste audio ----------
// Modèle local exécuté par un moteur fourni par l'utilisateur (Demucs recommandé —
// `pip install demucs`). Rien de bundlé. Le résultat « sans voix » (instrumental)
// devient une nouvelle piste audio du projet. Le moteur télécharge son modèle au
// premier usage. Deux stems : vocals / no_vocals.
let sepProc = null
function sepCfgPath() { return path.join(app.getPath('userData'), 'sep-config.json') }
function readSepCfg() { try { return JSON.parse(fs.readFileSync(sepCfgPath(), 'utf8')) } catch { return {} } }
ipcMain.handle('sep-config-get', () => readSepCfg())
ipcMain.handle('sep-config-set', (e, cfg) => { try { fs.writeFileSync(sepCfgPath(), JSON.stringify(cfg || {}), 'utf8') } catch {} return true })
ipcMain.handle('sep-pick-exe', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Demucs / séparation', properties: ['openFile'] })
  if (r.canceled || !r.filePaths.length) return null
  const cfg = readSepCfg(); cfg.exe = r.filePaths[0]
  try { fs.writeFileSync(sepCfgPath(), JSON.stringify(cfg), 'utf8') } catch {}
  return cfg.exe
})
function sepDir(projectPath) {
  const base = projectPath ? path.join(path.dirname(projectPath), 'separated') : path.join(appBaseDir(), 'cache', 'separated')
  try { fs.mkdirSync(base, { recursive: true }); return base } catch {}
  const fb = path.join(app.getPath('temp'), 'librerythmo-sep')
  try { fs.mkdirSync(fb, { recursive: true }) } catch {}
  return fb
}
function findFileRec(dir, rx) {
  let best = null, bestT = -1
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const en of ents) {
      const p = path.join(d, en.name)
      if (en.isDirectory()) walk(p)
      else if (rx.test(en.name)) { try { const st = fs.statSync(p); if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = p } } catch {} }
    }
  }
  walk(dir)
  return best
}
ipcMain.handle('sep-cancel', () => { try { if (sepProc) sepProc.kill() } catch {} sepProc = null; return true })
ipcMain.handle('sep-run', async (e, opts) => {
  if (!ffmpegPath) return { error: 'no-ffmpeg' }
  if (sepProc) return { error: 'busy' }
  const cfg = readSepCfg()
  const exe = cfg.exe
  if (!exe || !fs.existsSync(exe)) return { error: 'no-engine' }
  const src = opts.source
  if (!src || !fs.existsSync(src)) return { error: 'no-source' }
  const model = opts.model || 'htdemucs'
  const base = `lr-sep-${Date.now()}`
  const wav = path.join(app.getPath('temp'), base + '.wav')
  // 1) extraction de la piste audio ciblée en WAV stéréo qualité
  const extract = ['-y', '-i', src]
  if (opts.aIndex != null) extract.push('-map', `0:a:${opts.aIndex}`)
  extract.push('-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav)
  const okx = await new Promise((res) => { const p = spawn(ffmpegPath, extract, { stdio: 'ignore' }); p.on('close', (c) => res(c === 0)); p.on('error', () => res(false)) })
  if (!okx) return { error: 'extract-failed' }
  // 2) séparation (Demucs : --two-stems=vocals → vocals.wav + no_vocals.wav)
  const outDir = path.join(app.getPath('temp'), base + '-out')
  try { fs.mkdirSync(outDir, { recursive: true }) } catch {}
  const args = ['--two-stems', 'vocals', '-n', model, '-o', outDir, wav]
  return await new Promise((resolve) => {
    let tail = ''
    try { sepProc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { return resolve({ error: 'engine-spawn-failed' }) }
    const on = (d) => { const s = String(d); tail = (tail + s).slice(-4000); const m = s.match(/(\d+)%/); if (m && win && !win.isDestroyed()) win.webContents.send('sep-progress', { pct: Number(m[1]) }) }
    sepProc.stdout.on('data', on); sepProc.stderr.on('data', on)
    sepProc.on('close', (code) => {
      sepProc = null
      try { fs.unlinkSync(wav) } catch {}
      const found = findFileRec(outDir, /no_vocals\.(wav|mp3|flac|m4a)$/i)
      if (code === 0 && found) {
        const destName = (opts.destBase || 'sans-voix') + '-' + Date.now() + path.extname(found)
        const dest = path.join(sepDir(opts.projectPath), destName)
        try { fs.copyFileSync(found, dest) } catch { try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}; return resolve({ error: 'copy-failed' }) }
        try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}
        resolve({ ok: true, path: dest, name: destName })
      } else { try { fs.rmSync(outDir, { recursive: true, force: true }) } catch {}; resolve({ error: tail.slice(-300) || 'sep-failed' }) }
    })
    sepProc.on('error', () => { sepProc = null; resolve({ error: 'engine-spawn-failed' }) })
  })
})

// ---------- proxy vidéo (cache portable basse résolution H.264) ----------
// Dossier de cache dans le dossier de l'app (portable), repli sur le temp de l'OS si
// non accessible en écriture (clé USB protégée, emplacement read-only).
function appBaseDir() {
  try { return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname } catch { return __dirname }
}
let proxyDirCache = null
function proxyDir() {
  if (proxyDirCache) return proxyDirCache
  const primary = path.join(appBaseDir(), 'cache', 'proxies')
  const fallback = path.join(app.getPath('temp'), 'librerythmo-proxies')
  for (const dir of [primary, fallback]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, '.w')
      fs.writeFileSync(probe, '')
      fs.unlinkSync(probe)
      return (proxyDirCache = dir)
    } catch {}
  }
  return (proxyDirCache = app.getPath('temp'))
}
// nom du proxy = hash(chemin source + taille + mtime) → réutilisé entre sessions,
// invalidé automatiquement si la source change
function proxyPathFor(src) {
  let key = src
  try { const st = fs.statSync(src); key = `${src}|${st.size}|${Math.round(st.mtimeMs)}` } catch {}
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 16)
  return path.join(proxyDir(), `${hash}.mp4`)
}

let proxyProc = null
// génère (ou réutilise) un proxy 720p H.264 ; ne change QUE la résolution — jamais la
// cadence ni la durée (sinon décalage des timecodes). Progression via le `time=`.
ipcMain.handle('ensure-proxy', (e, src) => {
  if (!ffmpegPath || !src) return { error: 'no-ffmpeg' }
  const out = proxyPathFor(src)
  try { if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, cached: true } } catch {}
  if (proxyProc) { try { proxyProc.kill('SIGKILL') } catch {} proxyProc = null }
  return new Promise((resolve) => {
    const tmp = out + '.part'
    let dur = 0
    let logTail = ''
    // -map 0:V:0? : la VRAIE piste vidéo (V majuscule exclut les images attachées type
    //   pochette mjpeg des .mkv) ; -map 0:a:0? : la 1re piste audio ; -sn -dn : pas de
    //   sous-titres/données. format=yuv420p + -pix_fmt yuv420p : force le 8-bit — une source
    //   HEVC/H.264 10 bits (fréquent sur les .mkv d'anime « 10bits ») donnerait sinon un
    //   proxy H.264 High 10 que Chromium ne sait pas décoder → image figée/noire, tout
    //   décalé. -f mp4 : l'extension .part n'est pas reconnue par ffmpeg → format forcé.
    const args = ['-y', '-i', src, '-map', '0:V:0?', '-map', '0:a:0?', '-sn', '-dn', '-vf', 'scale=-2:720,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp]
    proxyProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    proxyProc.stderr.on('data', (d) => {
      const s = String(d); logTail = (logTail + s).slice(-2000)
      const dm = s.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
      if (dm) dur = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3])
      const tm = s.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/)
      if (tm && dur > 0 && win && !win.isDestroyed()) {
        const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3])
        win.webContents.send('proxy-progress', Math.min(99, Math.round((t / dur) * 100)))
      }
    })
    proxyProc.on('close', (code) => {
      proxyProc = null
      if (code === 0) {
        try { fs.renameSync(tmp, out); resolve({ path: out }) } catch (err) { resolve({ error: String(err) }) }
      } else {
        try { fs.unlinkSync(tmp) } catch {}
        resolve({ error: logTail.slice(-200) || 'proxy-failed' })
      }
    })
    proxyProc.on('error', () => { proxyProc = null; resolve({ error: 'spawn-failed' }) })
  })
})
ipcMain.handle('cancel-proxy', () => {
  if (proxyProc) { try { proxyProc.kill('SIGKILL') } catch {} proxyProc = null }
  return true
})
ipcMain.handle('clear-proxy-cache', () => {
  let count = 0, bytes = 0
  try {
    const dir = proxyDir()
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp4|part)$/.test(f)) continue
      const fp = path.join(dir, f)
      try { bytes += fs.statSync(fp).size; fs.unlinkSync(fp); count++ } catch {}
    }
  } catch {}
  return { count, bytes }
})

// ---------- détection de plans (changements de plan) via ffmpeg select=scene ----------
// On lance le filtre scene + metadata=print et on parse les `pts_time:` (secondes) du
// flux de log. La progression suit le `frame=`. Calqué sur probe-fps / l'export.
let detectProc = null
ipcMain.handle('detect-scenes', (e, opts) => {
  if (!ffmpegPath || !opts || !opts.path) return { error: 'ffmpeg introuvable ou chemin manquant' }
  if (detectProc) return { error: 'Une détection est déjà en cours' }
  const thr = Math.min(0.95, Math.max(0.05, Number(opts.threshold) || 0.5))
  return new Promise((resolve) => {
    const times = []
    let logTail = ''
    const scan = (s) => {
      let m
      const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g
      while ((m = re.exec(s))) times.push(parseFloat(m[1]))
      const fm = s.match(/frame=\s*(\d+)/)
      if (fm && win && !win.isDestroyed()) win.webContents.send('detect-progress', Number(fm[1]))
    }
    const args = ['-hide_banner', '-i', opts.path, '-filter:v', `select='gt(scene,${thr})',metadata=print`, '-an', '-f', 'null', '-']
    // metadata=print écrit selon les versions sur stdout ou stderr : on lit les deux
    detectProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (d) => { const s = String(d); logTail = (logTail + s).slice(-4000); scan(s) }
    detectProc.stdout.on('data', onData)
    detectProc.stderr.on('data', onData)
    detectProc.on('close', (code) => {
      detectProc = null
      if (code === 0 || times.length) resolve({ times })
      else resolve({ error: (logTail.slice(-300) || 'échec de la détection') })
    })
    detectProc.on('error', () => { detectProc = null; resolve({ error: 'ffmpeg introuvable' }) })
  })
})
ipcMain.handle('detect-cancel', () => {
  if (detectProc) { try { detectProc.kill('SIGKILL') } catch {} detectProc = null }
  return true
})

function encoderArgs(enc, W, H, fps) {
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', '19']
    case 'h264_amf': {
      const br = Math.max(4, Math.round((W * H * fps * 0.12) / 1e6))
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-b:v', `${br}M`]
    }
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']
  }
}

ipcMain.handle('export-save-dialog', async (e, suggestedPath) => {
  const r = await dialog.showSaveDialog(win, {
    title: S().dlgExport,
    defaultPath: suggestedPath || 'bande-rythmo.mp4',
    filters: [{ name: S().dlgExportFilter, extensions: ['mp4'] }],
  })
  return r.canceled || !r.filePath ? null : r.filePath
})

ipcMain.handle('export-start', async (e, opts) => {
  if (!ffmpegPath) return { error: 'ffmpeg introuvable (réinstalle les dépendances)' }
  if (exportProc) return { error: 'Un export est déjà en cours' }
  const enc = opts.encoder === 'cpu' ? 'libx264' : await probeEncoder()
  const { W, H, fps, duration, layout } = opts
  const ev = (n) => Math.max(2, Math.round(n / 2) * 2) // dimensions paires
  const vid = layout.video
  const band = layout.band
  const filter = [
    `color=black:size=${W}x${H}:rate=${fps}:d=${duration.toFixed(3)}[bg]`,
    `[1:v]scale=${ev(vid.w)}:${ev(vid.h)}[vid]`,
    `[bg][vid]overlay=${Math.round(vid.x)}:${Math.round(vid.y)}[base]`,
    `[base][0:v]overlay=${Math.round(band.x)}:${Math.round(band.y)}[outv]`,
    `[outv]fps=${fps}[out]`, // verrouille la cadence de sortie
  ].join(';')
  // entrées : 0 = bande (RGBA brut via pipe), 1 = vidéo. Les pistes audio
  // sélectionnées sont ajoutées comme entrées supplémentaires (2, 3, …) chacune avec
  // son -itsoffset (décalage gravé), puis mappées comme autant de pistes de sortie.
  // plage temporelle : on coupe la vidéo et les pistes audio à startTime (les frames
  // de bande, en entrée 0, sont déjà rendues à partir de startTime côté renderer)
  // seek d'entrée vers startTime ; -accurate_seek (défaut au ré-encodage) garantit un
  // démarrage frame-exact, donc la vidéo reste calée sur les frames de bande (rendues dès t0)
  const ss = Math.max(0, Number(opts.startTime) || 0)
  const seek = ss > 0 ? ['-accurate_seek', '-ss', ss.toFixed(3)] : []
  const inputs = [
    '-f', 'rawvideo', '-pixel_format', 'rgba',
    '-video_size', `${opts.bandW}x${opts.bandH}`, '-framerate', String(fps), '-i', 'pipe:0',
    ...seek, '-hwaccel', 'auto', '-i', opts.videoPath,
  ]
  const maps = ['-map', '[out]']
  const sel = (opts.audio || []).filter((a) => a.exported && a.path)
  // prises voix retenues (S1) à mixer par-dessus l'audio : chacune avec son offset
  // (position sur la timeline d'export, en secondes, déjà relatif à startTime côté
  // renderer). ⚠️ chemin à vérifier manuellement (mixage ffmpeg d'un vrai export).
  const takes = (opts.takes || [])
    .map((tk) => ({ ...tk, path: tk.path || (tk.name ? path.join(takesDir(opts.projectPath), tk.name) : null) }))
    .filter((tk) => tk.path && fs.existsSync(tk.path))
  let filterComplex = filter
  if (takes.length) {
    // mixage : piste audio de base sélectionnée (le cas échéant) + toutes les prises
    // → un unique flux [aout] via amix (normalize=0 conserve les niveaux d'origine).
    const audioFilters = []
    const labels = []
    let idx = 2
    const base = sel[0]
    if (base) {
      inputs.push(...seek, '-itsoffset', (Number(base.offset) || 0).toFixed(3), '-i', base.path)
      audioFilters.push(`[${idx}:a:${base.aIndex || 0}]aresample=async=1[am${idx}]`)
      labels.push(`[am${idx}]`); idx++
    }
    for (const tk of takes) {
      inputs.push('-itsoffset', (Number(tk.offset) || 0).toFixed(3), '-i', tk.path)
      audioFilters.push(`[${idx}:a]aresample=async=1[am${idx}]`)
      labels.push(`[am${idx}]`); idx++
    }
    const mix = labels.length > 1
      ? `${labels.join('')}amix=inputs=${labels.length}:normalize=0[aout]`
      : `${labels[0]}anull[aout]`
    filterComplex = filter + ';' + audioFilters.concat([mix]).join(';')
    maps.push('-map', '[aout]')
  } else if (sel.length) {
    sel.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)) // piste par défaut en premier
    let idx = 2
    for (const a of sel) {
      inputs.push(...seek, '-itsoffset', (Number(a.offset) || 0).toFixed(3), '-i', a.path)
      maps.push('-map', `${idx}:a:${a.aIndex || 0}`)
      idx++
    }
  } else {
    maps.push('-map', '1:a?') // repli : comportement historique (première piste audio)
  }
  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filterComplex,
    ...maps,
    ...encoderArgs(enc, W, H, fps),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-t', duration.toFixed(3),
    '-shortest',
    opts.outPath,
  ]
  let stderrTail = ''
  exportProc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  exportProc.stderr.on('data', (d) => {
    const s = String(d)
    stderrTail = (stderrTail + s).slice(-4000)
    const m = s.match(/frame=\s*(\d+)/)
    if (m) win.webContents.send('export-progress', Number(m[1]))
  })
  exportProc.on('close', (code) => {
    win.webContents.send('export-closed', code, code === 0 ? '' : stderrTail.slice(-600))
    exportProc = null
  })
  exportProc.stdin.on('error', () => {}) // EPIPE si annulation
  return { ok: true, encoder: enc }
})

ipcMain.handle('export-frame', async (e, buf) => {
  if (!exportProc) return false
  const ok = exportProc.stdin.write(Buffer.from(buf))
  if (!ok) await new Promise((r) => exportProc.stdin.once('drain', r))
  return true
})

ipcMain.handle('export-end', () => {
  if (exportProc) exportProc.stdin.end()
  return true
})

ipcMain.handle('export-cancel', () => {
  if (exportProc) {
    try { exportProc.kill('SIGKILL') } catch {}
    exportProc = null
  }
  return true
})
