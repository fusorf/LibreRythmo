# Changelog

Les changements notables de LibreRythmo. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/), versionnage [SemVer](https://semver.org/lang/fr/).

## [2.0.0] - 2026-06-18

### Conformité doublage FR
- **Lexique des réacs** (Cappella) : palette « Réactions » et insertion par touche, tokens
  localisés FR/EN, respirations normalisées (`fff`, `hhh`, `(mts)`, `(tst)`, `(snif)`…).
- **Attribut voix off** par réplique : texte souligné sur la bande, conservé à l'aller-retour DETX.
- Palette d'auto-attribution en encres sombres, lisibles sur fond clair comme sombre.

### Scènes
- Panneau **Scènes** : création au point de lecture, renommage, bornage début/fin, navigation
  scène précédente/suivante (Page ↑/↓), avertissement de durée, segments OUT. Bornes et nom
  affichés sur la bande.

### Édition
- **Recherche** dans les répliques (`Ctrl+F`).
- **Copier / couper / coller** de répliques avec leur calage et leurs bornes (`Ctrl+C/X/V`).
- **Import des personnages** d'un DETX dans le projet courant.
- **Décalage global** de toutes les répliques.

### Pistes audio & vidéo
- Onglet **Pistes** façon montage : vidéo de référence + pistes audio du conteneur, même
  zoom / défilement / curseur que la bande rythmo.
- **Offset par piste** au glisser, **piste active** (haut-parleur) dont la forme d'onde s'affiche
  sur la bande, **import d'un fichier audio externe**.
- Export : **choix des pistes rythmo, des scènes et de la piste audio** ; offsets gravés.

### Mode lecture
- **Plein écran (F5)** : aperçu vidéo + bande incrustée, contrôles auto-masqués (lecture,
  scène précédente/suivante, boucle de scène, zoom de bande, pistes, son).

### Divers
- **Discord Rich Presence** (Affichage), activé par défaut.

## [1.0.1] - 2026-06-12
- Détection des nouvelles versions au démarrage (toast cliquable vers les releases GitHub).

## [1.0.0] - 2026-06-12

Première version stable.

- Bande rythmo temps réel 1 à 4 pistes, élongation par mot, sync à l'image près.
- Édition souris : poignées par frontière de mot, multi-sélection, déplacement groupé,
  étirement proportionnel, mode aimant.
- Personnages (couleur par acteur), flèches d'entrée/sortie bouche ouverte/fermée.
- Import/export DETX (écosystème Joker / Cappella), SRT, export script PDF.
- Export MP4 composité (encodage GPU NVENC/QuickSync/AMF, repli x264).
- Projet `.rythmo` (JSON), autosave, projets récents, annuler/rétablir, thèmes clair/sombre,
  interface FR/EN.
