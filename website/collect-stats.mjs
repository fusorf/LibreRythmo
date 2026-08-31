// Logs the cumulative download total (all releases, all assets) to
// stats/downloads.json, one entry per day. Run daily by GitHub Actions so a
// time series builds up for a future chart. Safe to run more than once a day
// (it updates the day's entry in place).
//
//   node website/collect-stats.mjs

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'fusorf/LibreRythmo'
const FILE = path.join(__dirname, '..', 'stats', 'downloads.json')

const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'librerythmo-stats' }
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers })
if (!res.ok) { console.error(`GitHub API ${res.status}`); process.exit(1) }
const releases = await res.json()

let total = 0
const perVersion = {}
for (const r of releases) {
  let v = 0
  for (const a of r.assets || []) v += a.download_count || 0
  perVersion[r.tag_name] = v
  total += v
}

const today = new Date().toISOString().slice(0, 10)
let series = []
try { series = JSON.parse(await fs.readFile(FILE, 'utf8')) } catch { /* first run */ }
const last = series[series.length - 1]
const entry = { date: today, total, perVersion }
if (last && last.date === today) series[series.length - 1] = entry
else series.push(entry)

await fs.mkdir(path.dirname(FILE), { recursive: true })
await fs.writeFile(FILE, JSON.stringify(series, null, 2) + '\n')
console.log(`logged ${today}: ${total} downloads`)
