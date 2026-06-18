# Changelog

Les changements notables de LibreRythmo. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/), versionnage [SemVer](https://semver.org/lang/fr/).

## [1.2.0] - 2026-06-18

Boucles & structure de scène.

### Ajouté
- **Boucles (scènes)** : nouveau panneau « Boucles » (barre de transport) pour créer une boucle
  au point de lecture, la renommer, régler son début (⇤) / fin (⇥) sur le point de lecture, et
  sauter à son début d'un clic. Les bornes et le nom sont affichés sur la bande (liseré + onglet).
- **Navigation entre boucles** : boutons ◁ / ▷ du panneau et raccourcis **Page ↑ / Page ↓**
  (équivalent F11/F12 de Cappella).
- **Avertissement de durée** : la durée d'une boucle passe en rouge au-delà de ~50 s (boucle
  normale) ou en deçà de 30 s (segment OUT).
- **Segments OUT** : une boucle peut être marquée OUT (passage sans rien à doubler) ; rendu
  distinct sur la bande.
- Persistance des boucles dans le projet `.rythmo` (rétrocompatible : anciens projets sans
  boucles inchangés) ; intégrées à l'annuler/rétablir. Les boucles restent internes au `.rythmo`
  (non sérialisées en DETX pour l'instant).

## [1.1.0] - 2026-06-18

Conformité au standard du doublage FR (socle métier).

### Ajouté
- **Lexique des réacs** (Cappella) : la palette « Réactions » insère les tokens canoniques
  (`ah`, `oh`, `euh`, `fff`, `hhh`, `(rire)`, `(peur)`, `(snif)`…), avec la convention des
  parenthèses (onomatopée = texte nu, indication de jeu = entre parenthèses). **Insertion
  directe par la touche** indiquée sur chaque chip, ou au clic. **Tokens localisés** (FR ou EN
  selon la langue de l'UI). Une réac est posée comme une réplique courte, sans flèche
  entrée/sortie par défaut.
- **Respirations normalisées** intégrées au lexique : `fff` (expiration), `hhh` (aspiration),
  `(mts)` (lèvres), `(tst)` (langue), `(snif)` (reniflement) — chacune posable en une touche.
- **Attribut voix off** par réplique (bascule « Voix off » dans l'inspecteur) : bouche non visible
  à l'écran → texte **souligné** sur la bande. Survit à l'aller-retour DETX via un attribut
  `voiceoff` (ignoré par les autres outils, relu par LibreRythmo).

### Modifié
- **Palette d'auto-attribution** : nouveaux rôles en **encres sombres** saturées (lisibles sur
  fond clair comme sur le thème sombre) ; les couleurs vives/fluo sont réservées aux petits
  rôles, ambiances et voix médias (choix manuel via le sélecteur de couleur).

## [1.0.1] - 2026-06-12

### Ajouté
- Détection des nouvelles versions : vérification silencieuse des releases GitHub au
  démarrage ; si une mise à jour existe, un toast discret cliquable ouvre la page de
  téléchargement (aucun popup)
- À propos : statut de mise à jour affiché et bouton GitHub vers le dépôt

## [1.0.0] - 2026-06-12

Première version stable.

### Ajouté
- **Flèches d'entrée / sortie** par réplique : bouche ouverte (▲) ou fermée (▼) en début et
  fin de phrase, réglées dans l'inspecteur, rendues sur la bande et à l'export - alignées sur
  le modèle DETX (`in_open/in_close/out_open/out_close`)
- **Import / export DETX** (`Fichier → DETX`) : format d'échange des bandes rythmo
  (écosystème Joker / Cappella) - personnages, pistes, textes et flèches préservés ;
  glisser-déposer de `.detx` accepté
- **Export script PDF** (`Fichier → Exporter le script (PDF)…`) : conducteur de doublage
  façon cinéma (timecode, personnage en capitales avec pastille couleur, dialogue indenté,
  police machine à écrire, pagination)
- **Nombre de pistes réglable** (1 à 4, menu dans la barre de transport) : hauteur de piste
  fixe, moins de pistes = bande plus courte et plus de place pour la vidéo ; impossible de
  descendre sous le nombre de pistes utilisées (les pistes vides sont compactées)
- **Filtre par piste** dans le panneau Répliques
- **Overlay de chargement** bloquant pendant le chargement d'une vidéo (drop, ouverture,
  projet)
- **Release automatique GitHub Actions** : build Windows portable publié à chaque tag `v*`

### Modifié
- **Zoom exprimé en secondes visibles** (10 s → 3 s, défaut 5 s), partagé entre l'éditeur et
  l'export ; pistes plus hautes, règle du temps plus épaisse et plus lisible
- **Export simplifié** : position de la bande (haut / bas) + barre de séparation glissable
  pour régler les tailles vidéo/bande ensemble ; options regroupées en blocs « Sortie » et
  « Bande » ; hauteur de bande par défaut identique à l'éditeur
- **Détection de la cadence via ffmpeg** (métadonnées) : la timeline ne « saute » plus au
  chargement d'une vidéo, et la valeur est plus fiable
- **Refonte cohérence UI** : hauteur unique de tous les contrôles (30 px), barre de transport
  regroupée par fonction (lecture · édition · bande · panneaux), champs de saisie contrastés
  (fond sombre / texte blanc), timecodes compacts dans le panneau Répliques, focus clavier
  discret, tooltips allégés
- **Menus réorganisés** : sous-menus Sous-titres et DETX, raccourci `Ctrl+I` retiré ;
  la barre de menus native suit le thème clair / sombre
- **Langue par défaut** : anglais, ou français si le système est en français (le choix
  enregistré reste prioritaire)
- Garde-fou « modifications non enregistrées » étendu à l'ouverture d'un projet, aux projets
  récents et au glisser-déposer (plus de perte silencieuse)

## [0.2.0] - 2026-06-11

### Ajouté
- **Mode aimant** : bouton 🧲 dans la barre de transport (inactif par défaut) - en glissant,
  les bords des répliques s'aimantent aux bords des autres répliques et au point de lecture
  (seuil de 8 px à l'écran, s'adapte au zoom)
- **Mode clair** blanc cassé / beige (`Affichage → Mode clair`), appliqué à toute l'interface
  et au rendu de la bande
- **Panneau Répliques** déplacé dans une barre latérale gauche dédiée, avec son propre bouton
  d'affichage dans la barre de transport (liste chronologique, clic = saut au début)
- **Slider de zoom** à côté du volume - mêmes bornes que Ctrl+molette, échelle logarithmique,
  synchronisé dans les deux sens
- **Menu Édition** : Annuler / Rétablir (Ctrl+Z / Ctrl+Y), grisés quand les piles sont vides
- **Curseur de visée** : au survol de la règle du temps, un fin curseur rouge suit la souris
  avec son timecode ; le clic sur la règle saute à cet endroit (immédiat)
- **Réglages persistants** dans `settings.ini` (profil utilisateur) : langue, thème,
  enregistrement automatique, forme d'onde, infos vidéo, encodeur d'export
- **Projets récents** (`Fichier → Projets récents`, 8 max, purge automatique des chemins disparus)
- **Export** : sélecteur de thème de la bande (sombre / clair, défaut = mode courant) et
  choix de l'encodeur - GPU détecté (NVENC / QuickSync / AMF) ou CPU (x264), défaut GPU
- **Pastille de couleur** du personnage sélectionné sur le bouton « + Nouvelle réplique »
- État de l'enregistrement automatique affiché dans la barre de titre
- **Nouveau projet** (`Fichier → Nouveau projet`, `Ctrl+N`) : repart d'un projet
  vierge en proposant d'enregistrer les modifications en cours
  (Enregistrer / Ne pas enregistrer / Annuler)
- **Enregistrer sous…** (`Fichier → Enregistrer sous…`, `Ctrl+Maj+S`) : dialogue
  pré-rempli avec le fichier courant, le projet bascule sur le nouveau chemin
- Horodatage de build (date heure:minute:seconde) affiché dans `Aide → À propos`
- Crédits open source détaillés (`Aide → À propos` et README) : Electron, FFmpeg,
  ffmpeg-static, @electron/packager, ws - avec note de licence du binaire FFmpeg (GPL v3)

### Modifié
- **Poignées de calage repensées** : boutons de prise arrondis avec rainures sur chaque
  frontière de mot (extrémités plus grandes), surbrillance bleue au survol, chevrons quand
  Ctrl est tenu sur un bord extrême (étirement proportionnel), et pendant l'ajustement une
  ligne guide bleue traverse la bande avec le timecode de la frontière dans la règle
- **Marges autour des mots** sur la bande : le texte étiré ne colle plus aux
  séparateurs (marge proportionnelle à la hauteur de piste)
- **Extension de projet dédiée `.rythmo`** (contenu JSON inchangé) - les anciens
  projets `.json` se rouvrent normalement ; un projet déposé par glisser-déposer
  conserve désormais son chemin (titre, Ctrl+S, enregistrement automatique)
- Le **clic pour sauter** ne fonctionne plus que sur la règle du temps (plus de saut
  accidentel en cliquant entre les répliques), et sans délai
- Message de l'inspecteur vide réduit à « Aucune réplique sélectionnée · appuyez sur F1 pour l'aide »
- Langues du menu Affichage présentées en coches, comme les autres options
- Barres latérales élargies (232 → 280 px)
- Scrollbars sombres assorties au thème (et claires en mode clair)
- Les réglages ne passent plus par le localStorage : `settings.ini` fait foi,
  le menu est construit avec les bonnes valeurs dès le démarrage

## [0.1.0] - 2026-06-10

Version initiale.

- Bande rythmo temps réel sur 4 pistes : mots étirés sur leur durée réelle
  (élongation), point de lecture fixe, synchronisation à l'image près
- Pool de personnages (couleur, renommage, attribution par réplique)
- Édition à la souris : déplacement, poignées par frontière de mot,
  multi-sélection et déplacement groupé, étirement proportionnel (Ctrl+bord)
- Mot vide `_` (silence calé dans une réplique)
- Réactions standard de l'industrie ((breath), (laugh)…), affichées en français,
  insérées en anglais
- Import SRT, export / réimport SRT pour correction orthographique externe
  (calage mot à mot préservé si le nombre de mots ne change pas)
- Annuler / rétablir, 10 étapes
- Scrub sonore (grains audio) au glisser et à la molette
- Forme d'onde audio derrière la bande, détection automatique de la cadence
- Enregistrement automatique optionnel + confirmation de fermeture si non enregistré
- Export MP4 : composition vidéo + bande à disposition libre, encodage GPU
  (NVENC / QuickSync / AMF, repli x264), préview live
- Guide intégré (F1), interface bilingue FR/EN, menus natifs
