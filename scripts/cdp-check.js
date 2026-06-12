// Dev tool: drives the running app (launched with --remote-debugging-port=9222)
// through Chrome DevTools Protocol — loads a demo project + video, seeks, screenshots.
'use strict'
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 9222
const OUT = path.join(__dirname, 'cdp-shot.png')

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(JSON.parse(d)))
    }).on('error', reject)
  })
}

const demo = {
  version: 1,
  videoPath: path.join(__dirname, '..', 'media', 'trailer.mp4'),
  fps: 25,
  characters: [
    { id: 'c1', name: 'Marc', color: '#ffd23f' },
    { id: 'c2', name: 'Julie', color: '#4ecdc4' },
  ],
  lines: [
    {
      id: 'l1', characterId: 'c1', track: 0,
      words: [
        { text: 'Tu', start: 4.0, end: 4.25 },
        { text: 'croyais', start: 4.25, end: 4.9 },
        { text: 'vraiment', start: 4.9, end: 6.2 },
        { text: 'pouvoir', start: 6.4, end: 6.9 },
        { text: "t'échapper", start: 6.9, end: 8.4 },
      ],
    },
    {
      id: 'l2', characterId: 'c2', track: 1,
      words: [
        { text: 'Jamais', start: 5.5, end: 7.0 },
        { text: 'de', start: 7.0, end: 7.2 },
        { text: 'la', start: 7.2, end: 7.4 },
        { text: 'vie', start: 7.4, end: 8.6 },
      ],
    },
    {
      id: 'l3', characterId: 'c2', track: 2,
      words: [{ text: '(rire)', start: 8.8, end: 9.6 }],
    },
  ],
}

async function main() {
  const targets = await getTargets()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })

  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  await new Promise((r) => ws.on('open', r))

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails))
    return r.result.value
  }

  // load demo project + video
  await evaluate(`loadProjectData(${JSON.stringify(demo)}, null)`)
  await new Promise((r) => setTimeout(r, 1500)) // let the video load

  // wait for waveform decode (up to 30 s)
  for (let i = 0; i < 60; i++) {
    if (await evaluate('!!wave')) break
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('waveform ready:', await evaluate('!!wave'))
  const state = await evaluate(`(() => {
    video.currentTime = 5.8
    return { readyState: video.readyState, duration: video.duration, lines: project.lines.length, chars: project.characters.length }
  })()`)
  console.log('app state:', JSON.stringify(state))
  await new Promise((r) => setTimeout(r, 800)) // let the seek land + draw

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('screenshot:', OUT)

  ws.close()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
