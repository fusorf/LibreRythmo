// LibreRythmo — static site generator.
// Renders the trilingual (EN/FR/ES) landing page into dist/, injecting the
// current version, build date and per-platform download links pulled live
// from the GitHub Releases API. No hard-coded download URLs.
//
//   node website/build.mjs
//
// Config via env (defaults target GitHub Pages at fusorf.github.io/LibreRythmo):
//   SITE_ORIGIN   e.g. https://fusorf.github.io   (custom domain: https://librerythmo.com)
//   SITE_BASE     e.g. /LibreRythmo                (custom domain: "" empty)

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, 'src')
const OUT = path.join(__dirname, 'dist')

const REPO = 'fusorf/LibreRythmo'
const TWITTER = 'fusorf_'
const GITHUB_USER = 'fusorf'
const ORIGIN = (process.env.SITE_ORIGIN || 'https://fusorf.github.io').replace(/\/$/, '')
const BASE = process.env.SITE_BASE !== undefined ? process.env.SITE_BASE : '/LibreRythmo'
const RELEASES_LATEST = `https://github.com/${REPO}/releases/latest`

const LOCALES = ['en', 'fr', 'es']
const PATHS = { en: '/', fr: '/fr/', es: '/es/' } // en at root, others in subfolders

// --- helpers --------------------------------------------------------------
const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
// limited inline markup on already-escaped text: **bold** → <strong>
const rich = (s = '') => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
const url = (p) => `${BASE}${p}`.replace(/\/{2,}/g, '/') // internal (base-relative)
const abs = (p) => `${ORIGIN}${url(p)}`                   // absolute URL
const asset = (name) => url(`/assets/${name}`)

function fmtDate(iso, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' })
      .format(new Date(iso))
  } catch { return iso.slice(0, 10) }
}

function fmtNum(n, locale) {
  try { return new Intl.NumberFormat(locale).format(n) } catch { return String(n) }
}

// Total downloads = sum of every asset's download_count across all releases.
async function fetchDownloads() {
  try {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'librerythmo-site-build' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const data = await res.json()
    let total = 0
    for (const r of data) for (const a of r.assets || []) total += a.download_count || 0
    return total
  } catch (err) {
    console.warn(`  ! Downloads fetch failed (${err.message}); counter hidden.`)
    return null
  }
}

// Map a release asset filename to a platform slot.
function slotFor(name) {
  const n = name.toLowerCase()
  if (/setup.*\.exe$/.test(n) || n.endsWith('.exe')) return 'windows-installer'
  if (n.endsWith('.zip')) return 'windows-portable'
  if (/arm64.*\.dmg$/.test(n)) return 'macos-arm'
  if (/(x64|intel).*\.dmg$/.test(n)) return 'macos-intel'
  if (n.endsWith('.dmg')) return 'macos-arm'
  if (n.endsWith('.appimage')) return 'linux-appimage'
  if (n.endsWith('.deb')) return 'linux-deb'
  if (n.endsWith('.pacman')) return 'linux-pacman'
  return null
}

// --- release data ---------------------------------------------------------
async function fetchRelease() {
  const fallbackVersion = await readPkgVersion()
  const fallback = {
    version: fallbackVersion, tag: `v${fallbackVersion}`, publishedAt: new Date().toISOString(),
    htmlUrl: RELEASES_LATEST, links: {}, ok: false,
  }
  try {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'librerythmo-site-build' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const data = await res.json()
    const links = {}
    for (const a of data.assets || []) {
      const slot = slotFor(a.name)
      if (slot && !links[slot]) links[slot] = a.browser_download_url
    }
    return {
      version: (data.tag_name || `v${fallbackVersion}`).replace(/^v/, ''),
      tag: data.tag_name || `v${fallbackVersion}`,
      publishedAt: data.published_at || fallback.publishedAt,
      htmlUrl: data.html_url || RELEASES_LATEST,
      links, ok: true,
    }
  } catch (err) {
    console.warn(`  ! Release fetch failed (${err.message}); using package.json fallback.`)
    return fallback
  }
}

async function readPkgVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch { return '0.0.0' }
}

// Direct link for a slot, falling back to the releases page.
const linkFor = (rel, slot) => rel.links[slot] || RELEASES_LATEST

// --- HTML sections --------------------------------------------------------
function head(t, locale, rel) {
  const self = abs(PATHS[locale])
  const title = esc(t.meta.title)
  const desc = esc(t.meta.description)
  const ogImg = abs('/assets/og-image.jpg')
  const alternates = LOCALES.map(l =>
    `  <link rel="alternate" hreflang="${l}" href="${abs(PATHS[l])}">`).join('\n')

  const ldApp = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: 'LibreRythmo', applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Windows, macOS, Linux', softwareVersion: rel.version,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    downloadUrl: RELEASES_LATEST, url: self, image: ogImg,
    description: t.meta.description,
    license: 'https://www.gnu.org/licenses/gpl-3.0.html',
    author: { '@type': 'Person', name: 'fusorf', url: `https://github.com/${GITHUB_USER}` },
  }
  const ldFaq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: t.faq.items.map(i => ({
      '@type': 'Question', name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  }

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${desc}">
  <meta name="keywords" content="${esc(t.meta.keywords)}">
  <link rel="canonical" href="${self}">
${alternates}
  <link rel="alternate" hreflang="x-default" href="${abs(PATHS.en)}">
  <meta name="theme-color" content="#ffffff">
  <link rel="icon" href="${asset('icon.png')}" type="image/png">
  <link rel="apple-touch-icon" href="${asset('icon.png')}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="LibreRythmo">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${self}">
  <meta property="og:image" content="${ogImg}">
  <meta property="og:locale" content="${t.locale}">
${LOCALES.filter(l => l !== locale).map(l => `  <meta property="og:locale:alternate" content="${l}">`).join('\n')}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@${TWITTER}">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${ogImg}">
  <link rel="preconnect" href="https://api.github.com">
  <link rel="stylesheet" href="${asset('styles.css')}">
  <script type="application/ld+json">${JSON.stringify(ldApp)}</script>
  <script type="application/ld+json">${JSON.stringify(ldFaq)}</script>
</head>`
}

function nav(t, locale, rel) {
  const langLinks = LOCALES.map(l => {
    const active = l === locale ? ' aria-current="true"' : ''
    return `<a href="${url(PATHS[l])}" hreflang="${l}"${active}>${l.toUpperCase()}</a>`
  }).join('')
  return `<header class="nav">
  <div class="wrap nav__inner">
    <a class="brand" href="${url(PATHS[locale])}">
      <img src="${asset('icon.png')}" width="28" height="28" alt="">
      <span>LibreRythmo</span>
    </a>
    <nav class="nav__links">
      <a href="#features">${esc(t.nav.features)}</a>
      <a href="#faq">${esc(t.nav.faq)}</a>
      <a href="#download">${esc(t.nav.download)}</a>
      <a href="https://github.com/${REPO}" rel="noopener">${esc(t.nav.github)}</a>
    </nav>
    <div class="nav__lang" role="group" aria-label="Language">${langLinks}</div>
    <a class="btn btn--sm" href="#download">${esc(t.nav.download)}</a>
  </div>
</header>`
}

function hero(t, locale, rel) {
  const dataLinks = [
    `data-dl-windows="${esc(linkFor(rel, 'windows-installer'))}"`,
    `data-dl-macos="${esc(linkFor(rel, 'macos-arm'))}"`,
    `data-dl-linux="${esc(linkFor(rel, 'linux-appimage'))}"`,
    `data-cta-template="${esc(t.hero.ctaPrimary)}"`,
  ].join(' ')
  const release = t.hero.release
    .replace('{version}', rel.tag).replace('{date}', fmtDate(rel.publishedAt, locale))
  return `<section class="hero" style="--shot:url('${asset('screenshot-main.webp')}')">
  <div class="hero__bg" aria-hidden="true"></div>
  <div class="wrap hero__inner">
    <div class="hero__card">
      <div class="hero__logo">
        <img src="${asset('icon.png')}" width="52" height="52" alt="">
        <span>LibreRythmo</span>
      </div>
      <h1 class="hero__title">${esc(t.hero.title)}</h1>
      <p class="hero__sub">${rich(t.hero.subtitle)}</p>
      <div class="hero__cta">
        <a class="btn btn--primary" id="cta-download" href="${esc(rel.htmlUrl)}" ${dataLinks}>${esc(t.nav.download)}</a>
        <a class="btn btn--ghost" href="#download">${esc(t.hero.ctaSecondary)}</a>
      </div>
      <p class="hero__release" id="hero-release" data-tpl="${esc(t.hero.release)}">${esc(release)}</p>
    </div>
  </div>
</section>`
}

function features(t) {
  const blocks = t.features.map((f, i) => `
    <article class="feature${i % 2 ? ' feature--rev' : ''}">
      <div class="feature__text">
        <p class="kicker">${esc(f.kicker)}</p>
        <h3>${esc(f.title)}</h3>
        <p>${esc(f.body)}</p>
      </div>
      <div class="feature__media">
        <img src="${asset(f.img)}" alt="${esc(f.alt)}" width="900" loading="lazy">
      </div>
    </article>`).join('\n')
  return `<section class="features" id="features">
  <div class="wrap">${blocks}
  </div>
</section>`
}

function why(t) {
  const points = t.why.points.map(p => `
      <li class="why__point">
        <h4>${esc(p.title)}</h4>
        <p>${esc(p.body)}</p>
      </li>`).join('')
  return `<section class="why">
  <div class="wrap why__inner">
    <div class="why__head">
      <p class="kicker">${esc(t.why.kicker)}</p>
      <h2>${esc(t.why.title)}</h2>
      <p class="lead">${esc(t.why.body)}</p>
    </div>
    <ul class="why__grid">${points}
    </ul>
  </div>
</section>`
}

function faq(t) {
  const items = t.faq.items.map(i => `
      <details class="faq__item">
        <summary>${esc(i.q)}</summary>
        <div class="faq__a"><p>${esc(i.a)}</p></div>
      </details>`).join('')
  return `<section class="faq" id="faq">
  <div class="wrap faq__inner">
    <p class="kicker">${esc(t.faq.kicker)}</p>
    <h2>${esc(t.faq.title)}</h2>
    <div class="faq__list">${items}
    </div>
  </div>
</section>`
}

function download(t, locale, rel) {
  const L = t.download.labels
  const card = (title, rows) => `
      <div class="dl__card">
        <h3>${esc(title)}</h3>
        <ul>${rows.filter(Boolean).map(([slot, label]) =>
          `<li><a href="${esc(linkFor(rel, slot))}" data-slot="${slot}" rel="noopener">${esc(label)}</a></li>`).join('')}
        </ul>
      </div>`
  const current = t.download.current
    .replace('{version}', rel.tag).replace('{date}', fmtDate(rel.publishedAt, locale))
  return `<section class="download" id="download">
  <div class="wrap dl__inner">
    <p class="kicker">${esc(t.download.kicker)}</p>
    <h2>${esc(t.download.title)}</h2>
    <p class="lead">${esc(t.download.subtitle)}</p>
    <p class="dl__current" id="dl-current" data-tpl="${esc(t.download.current)}">${esc(current)}</p>
    ${rel.downloads != null ? `<p class="dl__downloads" id="dl-downloads" data-tpl="${esc(t.download.downloads)}">${esc(t.download.downloads.replace('{count}', fmtNum(rel.downloads, locale)))}</p>` : ''}
    <div class="dl__grid">
${card(t.download.platforms.windows, [['windows-installer', L['windows-installer']], ['windows-portable', L['windows-portable']]])}
${card(t.download.platforms.macos, [['macos-arm', L['macos-arm']], rel.links['macos-intel'] ? ['macos-intel', L['macos-intel']] : null])}
${card(t.download.platforms.linux, [['linux-appimage', L['linux-appimage']], ['linux-deb', L['linux-deb']], ['linux-pacman', L['linux-pacman']]])}
    </div>
    <p class="dl__all"><a href="https://github.com/${REPO}/releases" rel="noopener">${esc(t.download.allReleases)} →</a></p>
  </div>
</section>`
}

function footer(t, locale) {
  return `<footer class="foot">
  <div class="wrap foot__inner">
    <div class="foot__brand">
      <a class="brand" href="${url(PATHS[locale])}">
        <img src="${asset('icon.png')}" width="24" height="24" alt="">
        <span>LibreRythmo</span>
      </a>
      <p>${esc(t.footer.tagline)}</p>
    </div>
    <div class="foot__links">
      <p>${esc(t.footer.made)} <a href="https://github.com/${GITHUB_USER}" rel="noopener">@${GITHUB_USER}</a></p>
      <p>${esc(t.footer.contact)} <a href="https://twitter.com/${TWITTER}" rel="noopener">@${TWITTER}</a></p>
      <p><a href="https://github.com/${REPO}" rel="noopener">${esc(t.footer.license)}</a></p>
    </div>
  </div>
</footer>`
}

function page(t, locale, rel) {
  return `${head(t, locale, rel)}
<body>
${nav(t, locale, rel)}
<main>
${hero(t, locale, rel)}
${features(t)}
${why(t)}
${faq(t)}
${download(t, locale, rel)}
</main>
${footer(t, locale)}
<script src="${asset('app.js')}" defer></script>
</body>
</html>`
}

// --- SEO extras -----------------------------------------------------------
function sitemap(rel) {
  const lastmod = rel.publishedAt.slice(0, 10)
  const urls = LOCALES.map(l => {
    const alts = LOCALES.map(a =>
      `    <xhtml:link rel="alternate" hreflang="${a}" href="${abs(PATHS[a])}"/>`).join('\n')
    return `  <url>
    <loc>${abs(PATHS[l])}</loc>
    <lastmod>${lastmod}</lastmod>
${alts}
    <xhtml:link rel="alternate" hreflang="x-default" href="${abs(PATHS.en)}"/>
  </url>`
  }).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`
}

const robots = () => `User-agent: *
Allow: /
Sitemap: ${abs('/sitemap.xml')}
`

// --- build ----------------------------------------------------------------
async function copyAssets() {
  const dest = path.join(OUT, 'assets')
  await fs.mkdir(dest, { recursive: true })
  // static assets that live in src/assets
  const srcAssets = path.join(SRC, 'assets')
  for (const f of await fs.readdir(srcAssets)) {
    await fs.copyFile(path.join(srcAssets, f), path.join(dest, f))
  }
}

async function main() {
  console.log('Building LibreRythmo site…')
  console.log(`  origin=${ORIGIN} base='${BASE}'`)
  const rel = await fetchRelease()
  rel.downloads = await fetchDownloads()
  console.log(`  release ${rel.tag} (${rel.ok ? 'live' : 'fallback'}) · ${Object.keys(rel.links).length} assets · ${rel.downloads ?? '?'} downloads`)

  await fs.rm(OUT, { recursive: true, force: true })
  await fs.mkdir(OUT, { recursive: true })
  await copyAssets()

  for (const locale of LOCALES) {
    const t = JSON.parse(await fs.readFile(path.join(SRC, 'i18n', `${locale}.json`), 'utf8'))
    const html = page(t, locale, rel)
    const outDir = locale === 'en' ? OUT : path.join(OUT, locale)
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(path.join(outDir, 'index.html'), html)
    console.log(`  ✓ ${PATHS[locale]}`)
  }

  await fs.writeFile(path.join(OUT, 'sitemap.xml'), sitemap(rel))
  await fs.writeFile(path.join(OUT, 'robots.txt'), robots())
  await fs.writeFile(path.join(OUT, '.nojekyll'), '')
  // expose release data for the client-side live refresh
  await fs.writeFile(path.join(OUT, 'assets', 'release.json'), JSON.stringify({
    version: rel.version, tag: rel.tag, publishedAt: rel.publishedAt, links: rel.links,
  }))
  console.log('Done → website/dist')
}

main().catch(e => { console.error(e); process.exit(1) })
