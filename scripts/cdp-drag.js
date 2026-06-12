// Dev tool: dispatches a real mouse drag in the running app (CDP 9222).
// Usage: node scripts/cdp-drag.js x0 y0 x1 y1 [modifiers]   (modifiers: 2 = Ctrl)
'use strict'
const WebSocket = require('ws')
const http = require('http')

const [x0, y0, x1, y1, mods] = process.argv.slice(2).map(Number)

http.get('http://127.0.0.1:9222/json', (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', async () => {
    const page = JSON.parse(d).find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => ws.on('open', r))
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)()
        pending.delete(m.id)
      }
    })
    const send = (method, params) =>
      new Promise((resolve) => {
        const mid = ++id
        pending.set(mid, resolve)
        ws.send(JSON.stringify({ id: mid, method, params }))
      })
    const mouse = (type, x, y) =>
      send('Input.dispatchMouseEvent', {
        type, x, y,
        modifiers: mods || 0,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
        pointerType: 'mouse',
      })

    await mouse('mousePressed', x0, y0)
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)
      await new Promise((r) => setTimeout(r, 30))
    }
    await mouse('mouseReleased', x1, y1)
    console.log('drag done')
    ws.close()
  })
})
