'use strict'
// Worker de transcription : diarisation (locuteurs) + VAD (Silero) + Whisper via
// l'addon natif sherpa-onnx (aucun Python). Tourne dans un worker_thread pour ne pas
// figer le process principal (les appels natifs sont synchrones et longs). Produit la
// même liste de segments [{start,end,text,speaker}] que l'ancien script Python.
const { parentPort, workerData } = require('worker_threads')

function run() {
  const sherpa = require('sherpa-onnx-node')
  const { wav, enc, dec, tok, vadModel, seg, emb, lang, numSpeakers } = workerData
  const post = (m) => { try { parentPort.postMessage(m) } catch {} }

  const wave = sherpa.readWave(wav) // { samples: Float32Array, sampleRate }
  const sr = wave.sampleRate || 16000
  const samples = wave.samples
  const dur = samples.length ? samples.length / sr : 1

  // diarisation (best-effort) : ignorée proprement si ses modèles manquent → un seul locuteur
  let turns = []
  if (seg && emb) {
    try {
      const sd = new sherpa.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: seg } },
        embedding: { model: emb },
        clustering: Number(numSpeakers) > 0 ? { numClusters: Number(numSpeakers) } : { numClusters: -1, threshold: 0.7 },
        minDurationOn: 0.3, minDurationOff: 0.5,
      })
      turns = (sd.process(samples) || []).map((s) => [s.start, s.end, s.speaker])
    } catch (e) { post({ type: 'log', text: 'diar ' + e }) }
  }
  const speakerOf = (a, b) => {
    let best = -1, bov = 0
    for (const [s, e, sp] of turns) { const ov = Math.min(b, e) - Math.max(a, s); if (ov > bov) { bov = ov; best = sp } }
    return best >= 0 ? best : 0
  }

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      whisper: { encoder: enc, decoder: dec, language: lang === 'auto' ? '' : lang, task: 'transcribe' },
      tokens: tok, numThreads: 2, provider: 'cpu', debug: 0,
    },
  })

  const vad = new sherpa.Vad({
    sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.2, maxSpeechDuration: 15, windowSize: 512 },
    sampleRate: 16000, numThreads: 1,
  }, 180)

  const out = []
  const drain = () => {
    while (!vad.isEmpty()) {
      const s = vad.front()
      const start = s.start / 16000
      const st = recognizer.createStream()
      st.acceptWaveform({ samples: s.samples, sampleRate: 16000 })
      recognizer.decode(st)
      const text = ((recognizer.getResult(st) || {}).text || '').trim()
      const end = start + s.samples.length / 16000
      if (text) {
        out.push({ start, end, text, speaker: speakerOf(start, end) })
        post({ type: 'progress', pct: Math.min(100, Math.round((end / dur) * 100)) })
      }
      vad.pop()
    }
  }
  const window = 512
  for (let i = 0; i < samples.length; i += window) {
    vad.acceptWaveform(samples.subarray(i, i + window))
    drain()
  }
  vad.flush()
  drain()

  post({ type: 'done', segments: out })
}

try { run() } catch (e) { try { parentPort.postMessage({ type: 'error', error: String((e && e.stack) || e) }) } catch {} }
