// Dev tool: rasterizes assets/icon.svg → assets/icon.png via the running app (CDP 9222).
'use strict'
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')
const path = require('path')

const SIZE = 256
const svgUrl = 'file:///' + path.join(__dirname, '..', 'assets', 'icon.svg').replace(/\\/g, '/').replace(/ /g, '%20')
const expr = `(async () => {
  const img = new Image()
  img.src = ${JSON.stringify(svgUrl)}
  await img.decode()
  const c = document.createElement('canvas')
  c.width = ${SIZE}; c.height = ${SIZE}
  c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE})
  return c.toDataURL('image/png')
})()`

http.get('http://127.0.0.1:9222/json', (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', () => {
    const page = JSON.parse(d).find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id !== 1) return
      const url = m.result.result.value
      if (!url) {
        console.error('FAIL:', JSON.stringify(m.result))
        process.exit(1)
      }
      fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), Buffer.from(url.split(',')[1], 'base64'))
      console.log('assets/icon.png written')
      ws.close()
    })
  })
})
