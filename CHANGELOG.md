# Changelog

Les changements notables de LibreRythmo. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/), versionnage [SemVer](https://semver.org/lang/fr/).

## [2.6.0] - 2026-06-21

### Ajouts
- **Sous-titres** (menu Affichage, désactivé par défaut) : superposition de
  sous-titres « classiques » sur l'aperçu vidéo de l'éditeur — « Personnage : phrase »
  au bon timing, en bas et centré, fond noir et texte blanc, le nom du personnage
  en blanc avec un contour de sa couleur. Les répliques simultanées (plusieurs
  pistes) sont empilées ; les mots vides `_` ne sont pas affichés.

## [2.5.2] - 2026-06-19

### Ajustements
- Notification de nouvelle version : **bannière jaune persistante** avec bouton de fermeture
  (au lieu d'un toast qui disparaissait seul).
- Multi-sélection : la barre du bas permet aussi de **changer la piste** de toutes les
  répliques sélectionnées.

### Distribution
- **Installeurs** construits par GitHub Actions : Windows (NSIS `.exe` + zip portable),
  macOS `.dmg` (Intel & Apple Silicon), Linux `AppImage` / `.deb` (Ubuntu) / `.pacman` (Arch).

## [2.5.1] - 2026-06-19

### Ajustements
- Pastille « Optimisation de la lecture… » (génération du proxy) déplacée **en bas à droite**
  pour ne plus recouvrir l'inspecteur.
- Sensibilité par défaut de la **détection de plans** portée à **0.50**.
- Export : la place du champ **FPS personnalisé** est réservée — passer en « Personnalisée »
  ne change plus la taille de la fenêtre.

## [2.5.0] - 2026-06-19

### Plans
- Nouveau panneau **Plans** : ajout manuel au point de lecture et **détection automatique**
  des changements de plan (ffmpeg, slider de sensibilité). Marqueurs flèche sur la bande,
  liste avec renommage / suppression / clic = positionnement.

### Scènes
- **Stats à la volée** par scène (plage, durée, nombre de répliques et de personnages),
  affichées en ligne dans la liste.

### Import
- Import des sous-titres **ASS / SSA** et **VTT** (en plus de SRT/DETX), avec détection
  automatique du format.

### Polices
- **Police par défaut globale** modifiable **+ surcharge par réplique** ; chargement de
  polices **TTF/OTF** embarquées dans le projet (rendues à l'identique à l'export).
- **4 polices libres** fournies d'office (Inter, Oswald, Comfortaa, Anton — SIL OFL).

### Édition
- Menu du bas en **mode multi-sélection** : police, voix off et personnage applicables en
  lot, avec état indéterminé quand les valeurs diffèrent.

### Performance
- **Proxy vidéo** : génération en tâche de fond d'un proxy 720p H.264 mis en cache
  (lecture fluide sur 4K/HEVC, compatibilité codec universelle, détection de plans
  accélérée). L'export repart toujours de la source en pleine qualité.

### Export
- Cadence de sortie en **menu déroulant** (Source / 30 / 60 / 120 / Personnalisée), défaut 60.

### Interface
- Refonte de la **barre d'action** (plateau de transport segmenté, afficheur de temps,
  sélecteurs compacts), bascules de panneaux regroupées dans le bandeau du bas,
  uniformisation des listes latérales, icône poubelle pour la suppression de réplique.

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
