// Dev tool: boot the app under CDP and assert it loads without JS errors.
// Usage: node scripts/smoke.js
// Spawns `electron . --remote-debugging-port=9222`, waits for the page target,
// collects runtime exceptions + console errors, evaluates a list of sanity
// checks (key globals/functions must exist), then kills electron and exits
// non-zero if anything failed. Keeps CI-free local verification honest.
'use strict'
const WebSocket = require('ws')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const PORT = 9222
const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// checks: globals/functions that must exist once the renderer has booted.
const CHECKS = [
  'typeof project === "object" && !!project',
  'typeof renderBand === "function"',
  'typeof loadProjectData === "function"',
  'typeof insertReac === "function"',
  // v3 additions (guarded — only assert if present so baseline stays green)
  'typeof DET_SYMBOLS === "undefined" || Array.isArray(DET_SYMBOLS)',
  'typeof insertSymbol === "undefined" || typeof insertSymbol === "function"',
  'typeof recorder === "undefined" || typeof recorder === "object"',
]

function getJson() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
        })
      })
      .on('error', reject)
  })
}

async function main() {
  const electron = require('electron')
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let mainErr = ''
  child.stderr.on('data', (d) => (mainErr += String(d)))

  // wait for the CDP page target
  let page = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const targets = await getJson()
      page = targets.find((t) => t.type === 'page')
      if (page) break
    } catch {}
  }
  if (!page) {
    console.error('SMOKE FAIL: no page target (electron did not start)')
    if (mainErr) console.error(mainErr.slice(-1500))
    try { child.kill() } catch {}
    process.exit(1)
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  let id = 0
  const pending = new Map()
  const errors = []
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
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails
      errors.push('EXCEPTION: ' + (ex.exception ? ex.exception.description : ex.text))
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE.ERROR: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '))
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push('LOG.ERROR: ' + msg.params.entry.text)
    }
  })
  await new Promise((r) => ws.on('open', r))
  await send('Runtime.enable')
  await send('Log.enable')
  await sleep(4000) // let the renderer finish booting

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    if (r.exceptionDetails) return { ok: false, err: JSON.stringify(r.exceptionDetails) }
    return { ok: true, value: r.result.value }
  }

  let failed = 0
  for (const expr of CHECKS) {
    const r = await evaluate(expr)
    const pass = r.ok && r.value === true
    if (!pass) failed++
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${expr}${r.ok ? '' : '  <' + r.err + '>'}`)
  }

  if (errors.length) {
    failed += errors.length
    console.error('\nRuntime errors captured:')
    for (const e of errors.slice(0, 20)) console.error('  ' + e)
  }

  ws.close()
  try { child.kill() } catch {}
  await sleep(300)
  if (failed) {
    console.error(`\nSMOKE FAIL: ${failed} problem(s)`)
    process.exit(1)
  }
  console.log('\nSMOKE OK')
  process.exit(0)
}
main().catch((e) => {
  console.error('SMOKE FAIL:', e.message)
  process.exit(1)
})
