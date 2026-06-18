'use strict'
const { app, BrowserWindow, Menu, ipcMain, dialog, nativeTheme, shell } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
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
const DEFAULTS = { lang: 'fr', theme: 'dark', autosave: false, wave: true, info: false, encoder: 'gpu' }
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
    importSrt: 'Importer (SRT)…',
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
    quit: 'Quitter',
    edit: 'Édition',
    undo: 'Annuler',
    redo: 'Rétablir',
    view: 'Affichage',
    wave: "Forme d'onde audio",
    videoInfo: 'Infos vidéo',
    lightMode: 'Mode clair',
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
    dlgProject: 'Ouvrir un projet',
    dlgProjectFilter: 'Projet rythmo',
    dlgSave: 'Enregistrer le projet',
    dlgSrt: 'Importer des sous-titres SRT',
    dlgSrtFilter: 'Sous-titres',
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
    importSrt: 'Import (SRT)…',
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
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    view: 'View',
    wave: 'Audio waveform',
    videoInfo: 'Video info',
    lightMode: 'Light mode',
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
    dlgProject: 'Open a project',
    dlgProjectFilter: 'Rythmo project',
    dlgSave: 'Save project',
    dlgSrt: 'Import SRT subtitles',
    dlgSrtFilter: 'Subtitles',
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
      ],
    },
    {
      label: s.view,
      submenu: [
        { label: s.wave, type: 'checkbox', checked: settings.wave, click: (item) => send('toggle-wave', item.checked) },
        { label: s.videoInfo, type: 'checkbox', checked: settings.info, click: (item) => send('toggle-video-info', item.checked) },
        { label: s.lightMode, type: 'checkbox', checked: settings.theme === 'light', click: (item) => send('toggle-theme', item.checked) },
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
  settings.autosave = !!o.autosave
  if (['gpu', 'cpu'].includes(o.encoder)) settings.encoder = o.encoder
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
  const args = [
    '-y',
    '-f', 'rawvideo', '-pixel_format', 'rgba',
    '-video_size', `${opts.bandW}x${opts.bandH}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-hwaccel', 'auto', '-i', opts.videoPath,
    '-filter_complex', filter,
    '-map', '[out]', '-map', '1:a?',
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
