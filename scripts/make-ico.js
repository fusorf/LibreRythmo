// Dev tool: builds assets/icon.ico (16/32/48/256, PNG-compressed entries)
// by rasterizing assets/icon.svg through the running app (CDP port 9222).
'use strict'
const WebSocket = require('ws')
const http = require('http')
const fs = require('fs')
const path = require('path')

const SIZES = [16, 32, 48, 256]
const svgUrl = 'file:///' + path.join(__dirname, '..', 'assets', 'icon.svg').replace(/\\/g, '/').replace(/ /g, '%20')

function rasterExpr(size) {
  return `(async () => {
    const img = new Image()
    img.src = ${JSON.stringify(svgUrl)}
    await img.decode()
    const c = document.createElement('canvas')
    c.width = ${size}; c.height = ${size}
    c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
    return c.toDataURL('image/png')
  })()`
}

function buildIco(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const entries = []
  const datas = []
  let offset = 6 + 16 * count
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    datas.push(buf)
    offset += buf.length
  }
  return Buffer.concat([header, ...entries, ...datas])
}

http.get('http://127.0.0.1:9222/json', (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', async () => {
    const page = JSON.parse(d).find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    await new Promise((r) => ws.on('open', r))
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result)
        pending.delete(m.id)
      }
    })
    const evaluate = (expr) =>
      new Promise((resolve) => {
        const mid = ++id
        pending.set(mid, (r) => resolve(r.result.value))
        ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
      })

    const pngs = []
    for (const size of SIZES) {
      const url = await evaluate(rasterExpr(size))
      pngs.push({ size, buf: Buffer.from(url.split(',')[1], 'base64') })
    }
    fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), buildIco(pngs))
    console.log('assets/icon.ico written (' + SIZES.join(', ') + ' px)')
    ws.close()
  })
})
