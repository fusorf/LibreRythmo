'use strict'
// ============================================================ lexique des réacs
// Convention Cappella du doublage (v1.1). Chaque touche pose une réac (onomatopée,
// souffle ou indication de jeu) au point de lecture.
//
// Le token inséré est localisé : version FR quand l'UI est en français, version EN
// en anglais (`fr` / `en`). Convention des parenthèses, identique dans les deux
// langues :
//   - onomatopée / souffle vocalisé  → texte nu          (ah, oh, fff, hhh…)
//   - indication de jeu / bruitage   → entre parenthèses ((rire)/(laughs), (peur)…)
//
// `key` = touche d'insertion (la casse compte : « h » ≠ « H »).
// `type` regroupe les réacs par catégorie.
const REACS = [
  { key: 'a', fr: 'ah', en: 'ah', type: 'onoma' },
  { key: 'o', fr: 'oh', en: 'oh', type: 'onoma' },
  { key: 'u', fr: 'euh', en: 'uh', type: 'onoma' },
  { key: 'f', fr: 'fff', en: 'fff', type: 'breath' }, // expiration
  { key: 'h', fr: 'hhh', en: 'hhh', type: 'breath' }, // aspiration
  { key: 'H', fr: 'han !', en: 'unh!', type: 'onoma' },
  { key: 'g', fr: 'grrr', en: 'grrr', type: 'onoma' },
  { key: 'G', fr: 'argh !', en: 'argh!', type: 'onoma' },
  { key: 'M', fr: 'mmm', en: 'mmm', type: 'onoma' },
  { key: 'm', fr: '(mts)', en: '(smack)', type: 'breath' }, // claquement de lèvres
  { key: 't', fr: '(tst)', en: '(tsk)', type: 'breath' }, // claquement de langue
  { key: 's', fr: '(snif)', en: '(sniff)', type: 'breath' }, // reniflement
  { key: 'l', fr: '(pleure)', en: '(cries)', type: 'play' },
  { key: 'p', fr: '(peur)', en: '(fear)', type: 'play' },
  { key: 'j', fr: '(joie)', en: '(joy)', type: 'play' },
  { key: 'i', fr: '(rire)', en: '(laughs)', type: 'play' },
  { key: 'e', fr: '(effort)', en: '(effort)', type: 'play' },
  { key: 'c', fr: '(course)', en: '(running)', type: 'play' },
  { key: 'x', fr: '(X)', en: '(X)', type: 'misc' },
  { key: 'r', fr: '(reac)', en: '(reac)', type: 'generic' },
  { key: '?', fr: '(reac ?)', en: '(reac?)', type: 'generic' },
]

// touche → réac (la casse compte : « h » ≠ « H »)
const REAC_BY_KEY = new Map(REACS.map((r) => [r.key, r]))
