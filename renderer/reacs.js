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
  { key: 'a', fr: 'ah', en: 'ah', es: 'ah', type: 'onoma' },
  { key: 'o', fr: 'oh', en: 'oh', es: 'oh', type: 'onoma' },
  { key: 'u', fr: 'euh', en: 'uh', es: 'eh', type: 'onoma' },
  { key: 'f', fr: 'fff', en: 'fff', es: 'fff', type: 'breath' }, // expiration
  { key: 'h', fr: 'hhh', en: 'hhh', es: 'hhh', type: 'breath' }, // aspiration
  { key: 'H', fr: 'han !', en: 'unh!', es: '¡ah!', type: 'onoma' },
  { key: 'g', fr: 'grrr', en: 'grrr', es: 'grrr', type: 'onoma' },
  { key: 'G', fr: 'argh !', en: 'argh!', es: '¡argh!', type: 'onoma' },
  { key: 'M', fr: 'mmm', en: 'mmm', es: 'mmm', type: 'onoma' },
  { key: 'm', fr: '(mts)', en: '(smack)', es: '(mts)', type: 'breath' }, // claquement de lèvres
  { key: 't', fr: '(tst)', en: '(tsk)', es: '(tst)', type: 'breath' }, // claquement de langue
  { key: 's', fr: '(snif)', en: '(sniff)', es: '(snif)', type: 'breath' }, // reniflement
  { key: 'l', fr: '(pleure)', en: '(cries)', es: '(llora)', type: 'play' },
  { key: 'p', fr: '(peur)', en: '(fear)', es: '(miedo)', type: 'play' },
  { key: 'j', fr: '(joie)', en: '(joy)', es: '(alegría)', type: 'play' },
  { key: 'i', fr: '(rire)', en: '(laughs)', es: '(risa)', type: 'play' },
  { key: 'e', fr: '(effort)', en: '(effort)', es: '(esfuerzo)', type: 'play' },
  { key: 'c', fr: '(course)', en: '(running)', es: '(carrera)', type: 'play' },
  { key: 'x', fr: '(X)', en: '(X)', es: '(X)', type: 'misc' },
  { key: 'r', fr: '(reac)', en: '(reac)', es: '(reac)', type: 'generic' },
  { key: '?', fr: '(reac ?)', en: '(reac?)', es: '(¿reac?)', type: 'generic' },
]

// touche → réac (la casse compte : « h » ≠ « H »)
const REAC_BY_KEY = new Map(REACS.map((r) => [r.key, r]))
