// Captures the full site page from a headless Chrome (CDP port 9333),
// then crops feature slices. Dev-only helper for previewing the site.
'use strict'
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')
const path = require('path')
const PORT = Number(process.argv[2] || 9333)
const OUT = process.argv[3] || path.join(__dirname, '..', 'website', 'preview-page.png')

http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', async () => {
    const page = JSON.parse(d).find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
    })
    const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })) })
    await new Promise((r) => ws.on('open', r))
    await new Promise((r) => setTimeout(r, 800))
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    fs.writeFileSync(OUT, Buffer.from(s.data, 'base64'))
    console.log('saved', OUT)
    ws.close()
  })
})
