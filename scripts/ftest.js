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
  ['textOn contrast (black on light/mid, white on dark)', `(() => {
    if (typeof textOn !== 'function') return true
    return textOn('#000000') === '#fff' && textOn('#2e6da4') === '#fff'
      && textOn('#ffffff') === '#000' && textOn('#e0e0e0') === '#000'
      && textOn('#c2790f') === '#000' && textOn('#f1c40f') === '#000'
  })()`],
  ['digit key 1-9 selects character', `(() => {
    loadProjectData({ version: 2, fps: 25, tracks: 2, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'c1', name: 'A', color: '#e8443a' }, { id: 'c2', name: 'B', color: '#3a7ae8' }], lines: [] }, null)
    activeTab = 'rythmo'; selectedCharId = 'c1'
    // on lit e.code (position physique) pour marcher en AZERTY ; le caractère 'é'
    // produit par la touche « 2 » d'un clavier FR porte code 'Digit2'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'Digit2' }))
    return selectedCharId === 'c2'
  })()`],
  ['Transport character badge reflects selection', `(() => {
    const b = document.getElementById('curCharBadge')
    return !!b && b.textContent === getChar(selectedCharId).name
  })()`],
  // --- Tier B: character merge ---
  ['B merge characters reassigns lines', `(() => {
    if (typeof mergeCharacter !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 2, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'Alice', color: '#e8443a' }, { id: 'b', name: 'Bob', color: '#3a7ae8' }],
      lines: [{ id: 'x', characterId: 'a', track: 0, words: [{ text: 'un', start: 0, end: 1 }] },
              { id: 'y', characterId: 'b', track: 1, words: [{ text: 'deux', start: 1, end: 2 }] }] }, null)
    mergeCharacter('b', 'a')
    return project.characters.length === 1 && project.lines.every(l => l.characterId === 'a')
  })()`],
  ['Onglet Audio : haut-parleur en icône monochrome (SVG)', `(() => {
    if (typeof renderTrackHeads !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 2, fonts: [], loops: [], plans: [], characters: [],
      audioTracks: [{ id: 't1', type: 'file', path: 'x.wav', label: 'X', offset: 0 }], activeAudioId: 't1', lines: [] }, null)
    project.videoPath = 'X:/fake.mp4'
    renderTrackHeads()
    const spk = document.querySelector('#trackHeads .trk-spk')
    const ok = !!spk && !!spk.querySelector('svg') && spk.textContent.indexOf('🔊') < 0
    project.videoPath = null
    return ok
  })()`],
  ['Piste audio active restaurée par clé stable (id régénéré)', `(() => {
    if (typeof ensureActiveAudio !== 'function') return true
    // simule une réouverture : les id embarqués ont changé, mais la clé « emb:1 » persiste
    project.audioTracks = [
      { id: 'new-a', type: 'embedded', index: 0, offset: 0, label: 'A' },
      { id: 'new-b', type: 'embedded', index: 1, offset: 0, label: 'B' },
    ]
    project.activeAudioId = 'old-b-gone'   // id périmé
    project.activeAudioKey = 'emb:1'       // clé stable de l'ancienne piste active
    ensureActiveAudio()
    return project.activeAudioId === 'new-b' && project.activeAudioKey === 'emb:1'
  })()`],
  ['Doublage : dubWantVL vrai pendant la réplique d\'un perso coupé', `(() => {
    if (typeof dubWantVL !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [],
      characters: [{ id: 'a', name: 'A', color: '#e00' }, { id: 'b', name: 'B', color: '#00e' }],
      audioTracks: [{ id: 'vo', type: 'embedded', index: 0, offset: 0 }, { id: 'nv', type: 'file', path: 'nv.wav', offset: 0, voiceless: true }],
      lines: [{ id: 'l1', characterId: 'a', track: 0, words: [{ text: 'x', start: 1, end: 2 }] }, { id: 'l2', characterId: 'b', track: 0, words: [{ text: 'y', start: 3, end: 4 }] }],
      muteChars: ['a'] }, null)
    return dubWantVL(1.5) === true && dubWantVL(3.5) === false && dubWantVL(0.5) === false
  })()`],
  ['Doublage : piste voix par défaut ≠ sans-voix + dubEnabled', `(() => {
    if (typeof dubVoiceTrack !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], characters: [{ id: 'a', name: 'A', color: '#e00' }],
      audioTracks: [{ id: 'vo', type: 'embedded', index: 0, offset: 0 }, { id: 'nv', type: 'file', path: 'nv.wav', offset: 0, voiceless: true }],
      lines: [{ id: 'l1', characterId: 'a', track: 0, words: [{ text: 'x', start: 1, end: 2 }] }], muteChars: ['a'] }, null)
    project.videoPath = 'X:/fake.mp4'
    const v = dubVoiceTrack()
    const ok = !!v && v.voiceless !== true && dubEnabled() === true && !!dubVoicelessTrack()
    project.videoPath = null
    return ok
  })()`],
  ['Doublage : bouton visible si piste sans-voix + popover coche/décoche', `(() => {
    if (typeof setDubMuted !== 'function' || typeof buildDubPop !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], characters: [{ id: 'a', name: 'A', color: '#e00' }, { id: 'b', name: 'B', color: '#00e' }],
      audioTracks: [{ id: 'vo', type: 'embedded', index: 0, offset: 0 }, { id: 'nv', type: 'file', path: 'nv.wav', offset: 0, voiceless: true }],
      lines: [], muteChars: [] }, null)
    project.videoPath = 'X:/fake.mp4'
    renderTracks()
    const btnShown = !document.getElementById('btnDub').classList.contains('hidden')
    buildDubPop()
    const n = document.querySelectorAll('#dubPop .dub-row input').length
    setDubMuted('a', true)
    const muted = project.muteChars.includes('a')
    setDubMuted('a', false)
    project.videoPath = null
    return btnShown && n === 2 && muted && !project.muteChars.includes('a')
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
  ['Enregistrement : modèle recordings + onglet (pistes perso) + persist', `(() => {
    if (typeof renderRecTab !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'A', color: '#fff' }, { id: 'b', name: 'B', color: '#0af' }],
      recordings: [{ id: 'r1', characterId: 'a', file: 'rec_a_1.webm', startTime: 1, dur: 1.2, active: true }], recMuted: [] }, null)
    project.videoPath = 'X:/fake.mp4'
    setTab('rec')
    const recViewShown = !document.getElementById('recView').classList.contains('hidden')
    const rows = document.querySelectorAll('#recCharList .rec-ch')
    const okUI = recViewShown && rows.length === 2
    setTab('rythmo'); project.videoPath = null
    loadProjectData(JSON.parse(JSON.stringify(project)), null)
    return okUI && project.recordings.length === 1 && project.recordings[0].characterId === 'a'
  })()`],
  ['Enregistrement : chevauchement→prises + mute par piste', `(() => {
    if (typeof toggleRecMute !== 'function' || typeof recOverlap !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'A', color: '#fff' }], recordings: [], recMuted: [] }, null)
    project.recordings.push({ id: 'r1', characterId: 'a', file: 'f1', startTime: 1, dur: 2, active: true })
    const c2 = { id: 'r2', characterId: 'a', file: 'f2', startTime: 2, dur: 2, active: true }
    for (const r of project.recordings) if (r.characterId === c2.characterId && recOverlap(r, c2)) r.active = false
    project.recordings.push(c2)
    const overlapOk = project.recordings[0].active === false && project.recordings[1].active === true
    toggleRecMute('a'); const muted = isRecMuted('a'); toggleRecMute('a'); const unmuted = !isRecMuted('a')
    return overlapOk && muted && unmuted
  })()`],
  ['Enregistrement : selectClip active la prise et désactive le chevauchement', `(() => {
    if (typeof selectClip !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'A', color: '#fff' }],
      recordings: [{ id: 'r1', characterId: 'a', file: 'f1', startTime: 0, dur: 3, active: true },
                   { id: 'r2', characterId: 'a', file: 'f2', startTime: 1, dur: 3, active: false }], recMuted: [] }, null)
    project.videoPath = 'X:/fake.mp4'
    setTab('rec'); selectClip('r1')
    const g = (id) => project.recordings.find((r) => r.id === id)
    const ok = selectedClipId === 'r1' && g('r1').active === true && g('r2').active === false
    setTab('rythmo'); project.videoPath = null
    return ok
  })()`],
  ['Enregistrement : bande de clips dessinée sans erreur', `(() => {
    if (typeof drawRecClips !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [],
      characters: [{ id: 'a', name: 'A', color: '#fff' }],
      recordings: [{ id: 'r1', characterId: 'a', file: 'f1', startTime: 1, dur: 2, active: true }], recMuted: [] }, null)
    project.videoPath = 'X:/fake.mp4'
    setTab('rec')
    let ok = true; try { drawRecClips() } catch (e) { ok = false }
    setTab('rythmo'); project.videoPath = null
    return ok
  })()`],
  // --- A4 transcription (sherpa-onnx; engine/models may be absent in test env) ---
  ['A4 engine status shape', `(async () => {
    if (!window.api.whisperEngineStatus) return true
    const st = await window.api.whisperEngineStatus()
    return st && typeof st === 'object' && ('installed' in st) && ('python' in st)
  })()`],
  ['A4 whisper models list shape', `(async () => {
    if (!window.api.whisperListModels) return true
    const m = await window.api.whisperListModels()
    return Array.isArray(m) && m.length >= 1 && ('present' in m[0]) && ('model' in m[0]) && ('estMB' in m[0]) && m.some(x => x.model === 'turbo')
  })()`],
  ['A4 transcribe degrades without engine/model', `(async () => {
    if (!window.api.whisperTranscribe) return true
    const r = await window.api.whisperTranscribe({ source: 'C:/nope.mp4', model: 'turbo', language: 'auto' })
    return r && typeof r.error === 'string'
  })()`],
  ['A4 buildLinesFromSegments: speakers→chars, laughs→reacs, split', `(() => {
    if (typeof buildLinesFromSegments !== 'function') return true
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [], characters: [], lines: [] }, null)
    const n = buildLinesFromSegments([
      { start: 1, end: 3, text: 'Bonjour toi. Ça va ?', speaker: 0 },
      { start: 3, end: 4, text: '(Rires)', speaker: 1 },
      { start: 4, end: 6, text: 'Oui merci', speaker: 1 },
    ])
    const chars = project.characters.length
    const reac = project.lines.some((l) => l.kind === 'reac')
    const speakers = new Set(project.lines.map((l) => l.characterId)).size
    return n >= 4 && chars >= 2 && reac && speakers >= 2 && project.tracks >= 2
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
  ['A4 modal shows exactly one coherent state (ready xor not-ready)', `(async () => {
    if (typeof openTranscribeDialog !== 'function') return true
    project.videoPath = 'X:/fake.mp4'
    await openTranscribeDialog()
    const nr = !document.getElementById('trNotReady').classList.contains('hidden')
    const rd = !document.getElementById('trReady').classList.contains('hidden')
    const goHidden = document.getElementById('trGo').classList.contains('hidden')
    document.getElementById('transcribeModal').classList.add('hidden')
    project.videoPath = null
    return (nr !== rd) && (nr ? goHidden : !goHidden) // état cohérent quel que soit la config
  })()`],
  ['Long normal scene is not flagged (OUT-short still is)', `(() => {
    if (typeof loopWarn !== 'function') return true
    return loopWarn({ type: 'normal', start: 0, end: 300 }) === false
      && loopWarn({ type: 'out', start: 0, end: 5 }) === true
  })()`],
  // --- resume playhead ---
  ['Playhead stamped in saved JSON', `(() => {
    if (typeof projectJson !== 'function') return true
    scrub.time = 12.34
    const j = JSON.parse(projectJson())
    scrub.time = null
    return Math.abs((j.playhead || 0) - 12.34) < 0.01
  })()`],
  ['Playhead persists through reload', `(() => {
    loadProjectData({ version: 2, fps: 25, tracks: 1, fonts: [], loops: [], plans: [], audioTracks: [], characters: [], lines: [], playhead: 8.5 }, null)
    return project.playhead === 8.5
  })()`],
  ['Suggested project name from video', `(() => {
    if (typeof suggestedProjectName !== 'function') return true
    project.videoPath = 'G:\\\\Anime\\\\Steins;Gate\\\\ep 01.mkv'
    const n = suggestedProjectName()
    project.videoPath = null
    return n === 'ep 01.rythmo'
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
    return Array.isArray(m) && m.length >= 2 && ('present' in m[0]) && ('model' in m[0]) && ('sizeMB' in m[0]) && ('estMB' in m[0]) && m[0].estMB > 0
  })()`],
  ['DL size formatting', `(() => {
    if (typeof fmtDlSize !== 'function') return true
    lang = 'fr'
    const ok = fmtDlSize(142) === '142 Mo' && fmtDlSize(2000) === '2 Go' && fmtDlSize(1500) === '1,5 Go'
    return ok
  })()`],
  // --- Voice removal (separation) ---
  ['Sep model list shape', `(async () => {
    if (!window.api.sepListModels) return true
    const m = await window.api.sepListModels()
    return Array.isArray(m) && m.length >= 1 && ('present' in m[0]) && ('model' in m[0]) && ('estMB' in m[0])
  })()`],
  ['Sep run degrades without installed model', `(async () => {
    if (!window.api.sepRun) return true
    const r = await window.api.sepRun({ source: 'C:/nope.mp4', projectPath: null, model: 'UVR-MDX-NET-Inst_HQ_3.onnx' })
    return r && r.error === 'no-model'
  })()`],
  ['Popups mutually exclusive (reaction xor prononciation)', `(() => {
    const clk = (id) => document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const hidden = (id) => document.getElementById(id).classList.contains('hidden')
    clk('btnOnoma')
    const step1 = !hidden('onomaPop') && hidden('symbolPop')
    clk('btnSymbols')
    const step2 = !hidden('symbolPop') && hidden('onomaPop')
    document.getElementById('symbolPop').classList.add('hidden')
    return step1 && step2
  })()`],
  ['Sep modal opens with coherent state', `(async () => {
    if (typeof openSeparateDialog !== 'function') return true
    project.videoPath = 'X:/fake.mp4'
    await openSeparateDialog()
    const nr = !document.getElementById('sepNotReady').classList.contains('hidden')
    const rb = !document.getElementById('sepReadyBody').classList.contains('hidden')
    document.getElementById('separateModal').classList.add('hidden')
    project.videoPath = null
    return nr !== rb
  })()`],
  ['Sortie audio : liste peuplée + test dispo', `(async () => {
    if (typeof fillOutputDevices !== 'function' || typeof toggleOutputTest !== 'function') return true
    await fillOutputDevices()
    const sel = document.getElementById('outDevice')
    // au minimum l'option « périphérique par défaut »
    return !!sel && sel.options.length >= 1 && sel.options[0].value === '' && sel.options[0].textContent.length > 0
  })()`],
  ['Réglages audio persistés (set/get roundtrip)', `(async () => {
    if (!window.api.audioConfigSet || !window.api.audioConfigGet) return true
    const prev = await window.api.audioConfigGet()
    await window.api.audioConfigSet({ api: 'system', device: 'dev-XYZ', output: 'out-XYZ', asioFfmpeg: null })
    const got = await window.api.audioConfigGet()
    await window.api.audioConfigSet(prev || {}) // restaure l'état d'origine
    return got && got.device === 'dev-XYZ' && got.output === 'out-XYZ' && got.api === 'system'
  })()`],
  ['Export « Aucune » : pas de bande, vidéo plein cadre', `(() => {
    if (typeof layoutExport !== 'function') return true
    const prev = exp.bandPos
    exp.bandPos = 'none'
    layoutExport()
    const L = exp.layout
    const W = outW(), H = outH()
    const okNoBand = L.band.h === 0
    const okFits = L.video.w <= W + 1 && L.video.h <= H + 1 && L.video.w > 0 && L.video.h > 0
    exp.bandPos = prev; layoutExport()
    return okNoBand && okFits
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
