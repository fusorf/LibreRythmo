'use strict'
// ============================================================ signes de détection
// La détection est le cœur du métier : on pose sur le texte des signes qui
// indiquent au comédien / à l'adaptateur la forme de bouche (articulation
// visible) à respecter pour le lip-sync. Chaque signe cible une catégorie
// articulatoire. Convention pédagogique libre — pensée pour se former à la
// détection sans logiciel pro : le glyphe est un repère visuel dessiné au-dessus
// de la syllabe, le nom (info-bulle) donne la catégorie complète.
//
//   `key`   = touche d'insertion quand la palette de détection est ouverte
//   `glyph` = symbole dessiné sur la bande (au-dessus du mot ciblé)
//   `fr`/`en` = nom de la catégorie (info-bulle de la palette)
//   `hint`  = phonèmes représentatifs de la catégorie
//
// Les deux plus décisifs pour le lip-sync sont la labiale (P B M, lèvres fermées)
// et la labio-dentale (F V, lèvre sur les dents) : mouvements de bouche
// non ambigus qu'il faut absolument respecter.
const DET_SYMBOLS = [
  { key: 'p', glyph: '●', fr: 'Labiale (lèvres fermées)', en: 'Labial (lips closed)', hint: 'P B M' },
  { key: 'f', glyph: '◗', fr: 'Labio-dentale', en: 'Labiodental', hint: 'F V' },
  { key: 'o', glyph: '○', fr: 'Arrondie / avancée', en: 'Rounded / protruded', hint: 'CH J OU O U' },
  { key: 'a', glyph: '△', fr: 'Ouverture', en: 'Open vowel', hint: 'A È' },
  { key: 'd', glyph: '│', fr: "Dentale (point d'appui)", en: 'Dental (support)', hint: 'T D N L S Z' },
  { key: 'k', glyph: '⌒', fr: 'Vélaire (gutturale)', en: 'Velar (guttural)', hint: 'K G R' },
  { key: 'n', glyph: '~', fr: 'Nasale', en: 'Nasal', hint: 'AN ON IN' },
  { key: 'y', glyph: '‿', fr: 'Semi-voyelle / liaison', en: 'Glide / liaison', hint: 'Y W' },
]

// touche → signe (la casse compte) ; glyphe → signe (relecture / info-bulle)
const DET_BY_KEY = new Map(DET_SYMBOLS.map((s) => [s.key, s]))
const DET_BY_GLYPH = new Map(DET_SYMBOLS.map((s) => [s.glyph, s]))
