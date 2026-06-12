// Génère build-info.json (racine) avant le packaging : version + horodatage de build.
// Le process principal l'affiche dans Aide → À propos.
'use strict'
const fs = require('fs')
const path = require('path')
const pkg = require('../package.json')

const d = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const builtAt = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`

fs.writeFileSync(
  path.join(__dirname, '..', 'build-info.json'),
  JSON.stringify({ version: pkg.version, builtAt }, null, 2) + '\n'
)
console.log('build-info:', pkg.version, builtAt)
