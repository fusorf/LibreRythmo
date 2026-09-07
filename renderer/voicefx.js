// ============================================================ chaîne voix (FX)
// DSP hors-ligne pour une prise de voix parlée (doublage / voix-off), pré-calculé en
// WAV sidecar (fx_*.wav). Tout tourne sur Float32Array (pas d'AudioWorklet : le rendu
// est différé, pas de monitoring temps réel). Ordre imposé par la spec :
//   1 bruit* · 2 de-reverb* · 3 de-plosive · 4 passe-haut · 5 EQ · 6 de-esseur
//   · 7 comp lent · 8 comp rapide · 9 saturation · 10 réverbe · 11 limiteur + LUFS
// (* étages 1-2 = Partie B / IA, branchés plus tard : laissés hors chaîne pour l'instant.)
// Chaque étage est bypassable et expose ses paramètres (réglés par personnage, stockés
// dans le .rythmo). Le preset par défaut ci-dessous sème chaque nouveau personnage.
(function () {
  'use strict'

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v
  const dbToLin = (db) => Math.pow(10, db / 20)

  // ---------------------------------------------------------- preset par défaut
  const DEFAULTS = {
    enabled: false,           // la chaîne est-elle active pour ce personnage
    deplosive: { on: true, freq: 150, amount: 10 },                                  // 3
    highpass: { on: true, freq: 90 },                                                // 4 (18 dB/oct)
    eqLowMud: { on: true, dynamic: true, freq: 200, q: 1.0, gain: -3 },              // 5
    eqBoxy: { on: true, dynamic: false, freq: 400, q: 1.5, gain: -2 },               // 5
    eqPres: { on: false, dynamic: false, freq: 4000, q: 1.0, gain: 1.5 },            // 5 (optionnel)
    eqSib: { on: true, dynamic: true, freq: 7500, q: 2.0, gain: -1.5 },              // 5
    deesser: { on: true, freq: 6500, amount: 5 },                                    // 6
    compSlow: { on: true, threshold: -24, ratio: 2, attackMs: 30, releaseMs: 150 },  // 7 (~3 dB GR)
    compFast: { on: true, threshold: -18, ratio: 4, attackMs: 5, releaseMs: 80 },    // 8 (~3-4 dB GR)
    saturation: { on: false, drive: 30, mix: 8 },                                    // 9 (optionnel)
    reverb: { on: false, sizeS: 0.4, predelayMs: 20, mix: 8, hpf: 300 },             // 10 (optionnel)
    loudness: { on: true, targetLufs: -20, ceilingDb: -1 },                          // 11
  }

  const EQ_BANDS = ['eqLowMud', 'eqBoxy', 'eqPres', 'eqSib']

  // fusion profonde d'un preset partiel sur les défauts (rétrocompat des projets)
  function normalize(p) {
    const out = clone(DEFAULTS)
    if (p && typeof p === 'object') deepAssign(out, p)
    return out
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)) }
  function deepAssign(dst, src) {
    for (const k in src) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') deepAssign(dst[k], src[k])
      else if (k in dst) dst[k] = src[k]
    }
    return dst
  }
  // signature stable des réglages → détecte les sidecars périmés à re-rendre
  function sig(p) {
    const s = JSON.stringify(p)
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(36)
  }

  // ---------------------------------------------------------- biquad RBJ (O(n))
  // filtre par bande hors WebAudio ; supporte gain (peaking / shelf) pour l'EQ statique
  function biquadCoeffs(type, sr, fc, Q, gainDb) {
    const w0 = 2 * Math.PI * fc / sr, cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * Q)
    let b0, b1, b2, a0, a1, a2
    if (type === 'peaking' || type === 'lowshelf' || type === 'highshelf') {
      const A = Math.pow(10, gainDb / 40), sa = 2 * Math.sqrt(A) * al
      if (type === 'peaking') {
        b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A
        a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A
      } else if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cw + sa); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sa)
        a0 = (A + 1) + (A - 1) * cw + sa; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sa
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa)
        a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa
      }
    } else {
      if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al }
      else if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0 }
      else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0 } // highpass
      a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
  }
  function biquadRun(data, c, out) {
    out = out || new Float32Array(data.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < data.length; i++) {
      const x = data[i]
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
      x2 = x1; x1 = x; y2 = y1; y1 = y
      out[i] = y
    }
    return out
  }
  function biquadFilt(data, sr, type, fc, Q, gainDb) {
    return biquadRun(data, biquadCoeffs(type, sr, fc, Q, gainDb || 0))
  }
  function biquadRms(data, sr, type, fc, Q) {
    const y = biquadFilt(data, sr, type, fc, Q)
    let sq = 0
    for (let i = 0; i < y.length; i++) sq += y[i] * y[i]
    return 10 * Math.log10(sq / Math.max(1, y.length) + 1e-12)
  }

  // applique un biquad en place sur tous les canaux d'un AudioBuffer
  function applyBiquad(buf, type, fc, Q, gainDb) {
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c)
      d.set(biquadFilt(d, buf.sampleRate, type, fc, Q, gainDb))
    }
  }

  // ---------------------------------------------------------- réduction dynamique de bande
  // suit l'enveloppe d'une bande (dé-esseur, anti-plosive, EQ dynamique) : la bande n'est
  // atténuée que pendant les pointes qui dépassent de `overDb` son niveau voisé moyen ;
  // pas de coloration statique le reste du temps.
  function tameBand(buf, type, fc, Q, overDb, maxCutDb, attMs, relMs) {
    const sr = buf.sampleRate
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const x = buf.getChannelData(c)
      const band = biquadFilt(x, sr, type, fc, Q)
      const win = Math.max(1, Math.round(sr * 0.05))
      const w = []
      for (let i = 0; i + win <= band.length; i += win) {
        let sq = 0
        for (let k = i; k < i + win; k++) sq += band[k] * band[k]
        w.push(10 * Math.log10(sq / win + 1e-12))
      }
      const mx = w.length ? Math.max(...w) : -90
      const voiced = w.filter((v) => v > mx - 30)
      const thr = (voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : mx) + overDb
      const ga = Math.exp(-1000 / (sr * attMs)), gr = Math.exp(-1000 / (sr * relMs))
      let env = 0
      for (let i = 0; i < x.length; i++) {
        const a = Math.abs(band[i])
        env = a > env ? ga * env + (1 - ga) * a : gr * env + (1 - gr) * a
        const eDb = 20 * Math.log10(env + 1e-12)
        if (eDb <= thr) continue
        const cut = Math.min(maxCutDb, (eDb - thr) * 0.8)
        x[i] -= (1 - Math.pow(10, -cut / 20)) * band[i]
      }
    }
  }

  // ---------------------------------------------------------- compresseur (feed-forward)
  // détecteur de crête lissé, gain computer à genou doux, ratio/attaque/release exposés.
  function compress(buf, P) {
    const sr = buf.sampleRate
    const knee = 6
    const ga = Math.exp(-1000 / (sr * P.attackMs)), gr = Math.exp(-1000 / (sr * P.releaseMs))
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const x = buf.getChannelData(c)
      let env = 0
      for (let i = 0; i < x.length; i++) {
        const a = Math.abs(x[i])
        env = a > env ? ga * env + (1 - ga) * a : gr * env + (1 - gr) * a
        const lvl = 20 * Math.log10(env + 1e-12)
        const over = lvl - P.threshold
        let gdb = 0
        if (over >= knee / 2) gdb = over * (1 / P.ratio - 1)
        else if (over > -knee / 2) { const t = over + knee / 2; gdb = (1 / P.ratio - 1) * t * t / (2 * knee) }
        x[i] *= Math.pow(10, gdb / 20)
      }
    }
  }

  // ---------------------------------------------------------- saturation douce (tanh)
  function saturate(buf, P) {
    const drive = 1 + Math.max(0, P.drive) / 10  // 0..100 → 1..11
    const mix = clamp(P.mix / 100, 0, 1)
    const norm = Math.tanh(drive) || 1
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const x = buf.getChannelData(c)
      for (let i = 0; i < x.length; i++) {
        const wet = Math.tanh(x[i] * drive) / norm
        x[i] = x[i] * (1 - mix) + wet * mix
      }
    }
  }

  // ---------------------------------------------------------- réverbe courte (ConvolverNode)
  // seule étape en OfflineAudioContext : IR de petite pièce générée (bruit décroissant),
  // passe-haut sur le wet, mélange dry/wet. Off par défaut.
  async function reverb(buf, P) {
    const sr = buf.sampleRate
    const pre = Math.max(0, Math.round(sr * (P.predelayMs || 0) / 1000))
    const irLen = Math.max(1, Math.round(sr * clamp(P.sizeS, 0.1, 2)))
    const ir = new OfflineAudioContext(1, pre + irLen, sr).createBuffer(1, pre + irLen, sr)
    const id = ir.getChannelData(0)
    let seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1 }
    for (let i = 0; i < irLen; i++) id[pre + i] = rnd() * Math.pow(1 - i / irLen, 2.5)
    const off = new OfflineAudioContext(buf.numberOfChannels, buf.length, sr)
    const src = off.createBufferSource(); src.buffer = buf
    const dry = off.createGain(); dry.gain.value = 1
    const wet = off.createGain(); wet.gain.value = clamp(P.mix / 100, 0, 1)
    const conv = off.createConvolver(); conv.normalize = true; conv.buffer = ir
    const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = P.hpf || 300; hp.Q.value = 0.71
    src.connect(dry); dry.connect(off.destination)
    src.connect(hp); hp.connect(conv); conv.connect(wet); wet.connect(off.destination)
    src.start()
    return off.startRendering()
  }

  // ---------------------------------------------------------- mesure LUFS (ITU-R BS.1770 / EBU R128)
  // K-weighting (pré-filtre high-shelf + RLB highpass, coefficients recalculés au taux
  // d'échantillonnage), intégration par blocs de 400 ms, gating absolu -70 / relatif -10 LU.
  function kCoeffs(sr) {
    // pré-filtre (high shelf ~ +4 dB)
    let f0 = 1681.9744509555319, G = 3.999843853973347, Q = 0.7071752369554196
    let K = Math.tan(Math.PI * f0 / sr)
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416)
    let a0 = 1 + K / Q + K * K
    const pre = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 }
    // RLB (highpass)
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / sr)
    a0 = 1 + K / Q + K * K
    const rlb = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 }
    return { pre, rlb }
  }
  function measureLufs(buf) {
    const sr = buf.sampleRate
    const { pre, rlb } = kCoeffs(sr)
    // somme pondérée des canaux (mono/stéréo : poids 1.0)
    const n = buf.length
    const zsum = new Float64Array(n)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const y = biquadRun(biquadRun(buf.getChannelData(c), pre), rlb)
      for (let i = 0; i < n; i++) zsum[i] += y[i] * y[i]
    }
    const block = Math.round(sr * 0.4), hop = Math.round(sr * 0.1)
    if (n < block) return -70
    const zBlocks = []
    for (let i = 0; i + block <= n; i += hop) {
      let s = 0
      for (let k = i; k < i + block; k++) s += zsum[k]
      zBlocks.push(s / block)
    }
    const loud = (z) => -0.691 + 10 * Math.log10(z + 1e-12)
    // gate absolu -70 LUFS
    let kept = zBlocks.filter((z) => loud(z) > -70)
    if (!kept.length) return -70
    // gate relatif : moyenne des blocs gardés − 10 LU
    const mean = kept.reduce((a, b) => a + b, 0) / kept.length
    const rel = loud(mean) - 10
    kept = kept.filter((z) => loud(z) > rel)
    if (!kept.length) return -70
    return loud(kept.reduce((a, b) => a + b, 0) / kept.length)
  }

  // ---------------------------------------------------------- limiteur brickwall look-ahead
  // le gain baisse `la` échantillons avant la pointe (attaque douce via lookahead), release
  // exponentiel, puis contrôle true-peak suréchantillonné 4× et rabot final si dépassement.
  function limit(buf, ceilingDb) {
    const sr = buf.sampleRate
    const ceil = dbToLin(ceilingDb)
    const la = Math.max(1, Math.round(sr * 0.0015))
    const rel = Math.exp(-1000 / (sr * 50))
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const x = buf.getChannelData(c)
      const n = x.length
      // gain désiré par échantillon d'après la pointe dans la fenêtre [i, i+la]
      const desired = new Float32Array(n)
      let winMax = 0
      // fenêtre glissante de max (recalcul simple mais borné par la petite taille de la)
      for (let i = 0; i < n; i++) {
        if (i % la === 0) { winMax = 0; for (let k = i; k < Math.min(n, i + la); k++) { const a = Math.abs(x[k]); if (a > winMax) winMax = a } }
        desired[i] = winMax > ceil ? ceil / winMax : 1
      }
      const out = new Float32Array(n)
      let env = 1
      for (let i = 0; i < n; i++) {
        const tgt = desired[i]
        env = tgt < env ? tgt : env * rel + tgt * (1 - rel)
        const j = i - la
        out[i] = (j >= 0 ? x[j] : 0) * env
      }
      // true-peak : suréchantillonnage linéaire 4× → rabot statique si > plafond
      let tp = 0
      for (let i = 0; i < n - 1; i++) {
        const a = out[i], b = out[i + 1]
        for (let s = 0; s < 4; s++) { const v = Math.abs(a + (b - a) * s / 4); if (v > tp) tp = v }
      }
      const trim = tp > ceil ? ceil / tp : 1
      if (trim < 1) for (let i = 0; i < n; i++) out[i] *= trim
      x.set(out)
    }
  }

  // ---------------------------------------------------------- chaîne complète
  async function process(buf, params) {
    const P = normalize(params)
    const meter = {}
    // 3 · de-plosive (passe-haut dynamique piloté par l'énergie grave)
    if (P.deplosive.on) tameBand(buf, 'lowpass', P.deplosive.freq, 0.9, 6, P.deplosive.amount, 2, 60)
    // 4 · passe-haut 18 dB/oct (3 biquads Butterworth cascadés)
    if (P.highpass.on) { for (let k = 0; k < 3; k++) applyBiquad(buf, 'highpass', P.highpass.freq, 0.707) }
    // 5 · EQ (bandes statiques ou dynamiques)
    if (P.eqLowMud.on || P.eqBoxy.on || P.eqPres.on || P.eqSib.on) {
      for (const key of EQ_BANDS) {
        const b = P[key]; if (!b.on) continue
        if (b.dynamic && b.gain < 0) tameBand(buf, 'bandpass', b.freq, b.q, 2, -b.gain, 3, 80)
        else applyBiquad(buf, 'peaking', b.freq, b.q, b.gain)
      }
    }
    // 6 · de-esseur (sidechain passe-bande 6-8 kHz)
    if (P.deesser.on) tameBand(buf, 'bandpass', P.deesser.freq, 2, 6, P.deesser.amount, 1, 60)
    // 7 · compresseur lent (lissage) · 8 · compresseur rapide (pics)
    if (P.compSlow.on) compress(buf, P.compSlow)
    if (P.compFast.on) compress(buf, P.compFast)
    // 9 · saturation douce (optionnel)
    if (P.saturation.on) saturate(buf, P.saturation)
    // 10 · réverbe courte (optionnel, OfflineAudioContext)
    if (P.reverb.on) buf = await reverb(buf, P.reverb)
    // 11 · normalisation LUFS + limiteur true-peak
    if (P.loudness.on) {
      const lufs = measureLufs(buf)
      const gainDb = clamp(P.loudness.targetLufs - lufs, -24, 24)
      const g = dbToLin(gainDb)
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g }
      limit(buf, P.loudness.ceilingDb)
      meter.lufsIn = lufs; meter.gainDb = gainDb; meter.targetLufs = P.loudness.targetLufs
    }
    return { buffer: buf, meter }
  }

  window.VoiceFx = { DEFAULTS, EQ_BANDS, normalize, clone, sig, process }
})()
