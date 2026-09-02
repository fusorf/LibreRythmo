'use strict'
// Récupère le binaire yt-dlp dans assets/bin/ pour l'embarquer avec l'appli
// (import YouTube). Lancé au npm install (postinstall) ; best-effort : en cas
// d'échec (hors-ligne…), l'appli le téléchargera elle-même au premier usage.
// yt-dlp est sous licence Unlicense (domaine public) — compatible GPL.
const fs = require('fs')
const path = require('path')

const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'
const BIN = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const dest = path.join(__dirname, '..', 'assets', 'bin', BIN)

async function main() {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1e6) { console.log('yt-dlp déjà présent :', dest); return }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + ASSET
  console.log('Téléchargement de yt-dlp…', url)
  const res = await fetch(url, { headers: { 'User-Agent': 'LibreRythmo' }, redirect: 'follow' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest + '.part', buf)
  fs.renameSync(dest + '.part', dest)
  if (process.platform !== 'win32') { try { fs.chmodSync(dest, 0o755) } catch {} }
  console.log('yt-dlp installé :', dest, Math.round(buf.length / 1e6) + ' Mo')
}

main().catch((err) => { console.warn('fetch-ytdlp: échec (non bloquant) —', err.message) })
