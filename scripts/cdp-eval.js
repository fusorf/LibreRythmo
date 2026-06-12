// Dev tool: evaluates a JS expression in the running app (CDP port 9222).
// Usage: node scripts/cdp-eval.js "expression"
'use strict'
const WebSocket = require('ws')
const http = require('http')

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(JSON.parse(d)))
    }).on('error', reject)
  })
}

async function main() {
  const targets = await getTargets()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: process.argv[2], awaitPromise: true, returnByValue: true } }))
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id === 1) {
      console.log(JSON.stringify(msg.result, null, 2))
      ws.close()
    }
  })
}
main().catch((e) => { console.error(e.message); process.exit(1) })
