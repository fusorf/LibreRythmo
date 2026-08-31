# Changelog

Les changements notables de LibreRythmo. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/), versionnage [SemVer](https://semver.org/lang/fr/).

## [2.7.3] - 2026-08-31

### Corrections
- **Forme d'onde / scrub décalés du son au chargement** : la forme d'onde était
  construite avant le sondage des pistes audio embarquées et retombait sur le
  décodage du conteneur brut (`.mkv`) par le navigateur, dont le rééchantillonnage
  48 kHz → 16 kHz dérivait progressivement (jusqu'à plusieurs secondes d'avance en
  fin de vidéo). Elle est désormais (re)construite une fois les pistes connues, à
  partir de l'extraction ffmpeg de la piste active — calée sur la lecture, sans
  dérive. Toute piste embarquée (la première comprise) passe par cette extraction,
  au lieu de laisser `decodeAudioData` décoder le conteneur.
- **Proxy vidéo 10 bits** : une source 10 bits (HEVC ou H.264 « 10bits », fréquent
  sur les `.mkv`) produisait un proxy H.264 High 10 que Chromium ne sait pas décoder
  (image figée / noire). Le proxy est désormais forcé en 8 bits (`format=yuv420p`) et
  ne mappe que la vraie piste vidéo + la première piste audio (les images de
  couverture et pistes de sous-titres/données sont exclues).

## [2.7.2] - 2026-07-26

### Ajouts
- **Piste préférée par personnage** : menu compact P1–P4 sur chaque ligne du panneau
  Personnages — les nouvelles répliques du personnage vont en priorité sur cette
  piste ; « – » (défaut) ou piste non affichée dans le projet = placement
  automatique habituel (piste où le personnage figure déjà, sinon première libre).

### Corrections
- **Inspecteur** : champ texte actif + clic sur une autre réplique → le champ
  gardait l'ancien texte (qui pouvait alors écraser la réplique nouvellement
  sélectionnée à la frappe). Les champs texte / début / fin suivent désormais le
  changement de réplique même quand ils ont le focus.
- **Vidéo de projet introuvable** : le lecteur est vidé (une vidéo chargée
  précédemment restait affichée avec les répliques du nouveau projet) et l'invite
  « Vidéo du projet introuvable — glisse la vidéo ici… » reste visible, au lieu
  d'un simple toast de 2 secondes.

### Ajustements
- **Redimensionnement des mots** : glisser une frontière compresse / étend
  proportionnellement tout le texte du côté opposé, sans bouger les bornes de la
  réplique ; Ctrl + glisser retrouve l'ancien comportement (seuls le mot et son
  voisin bougent). Chevrons de survol et guide mis à jour.

## [2.7.1] - 2026-07-08

### Ajustements
- **Barre de progression** : hauteur fixe (plus d'agrandissement au survol), le point
  de lecture est un trait qui s'épaissit pendant le scrub (plus de pastille), et
  l'infobulle est bien cachée par défaut et disparaît quand la souris quitte la barre
  (elle restait affichée, vide, sans projet chargé).

### Distribution
- CI : retrait du build macOS Intel (runners `macos-13` retirés par GitHub — le job
  attendait 24 h et faisait annuler le run entier ; v2.6.0/v2.6.1 n'avaient jamais
  eu leurs installeurs complets). macOS = DMG Apple Silicon uniquement.

## [2.7.0] - 2026-07-08

### Ajouts
- **Barre de progression globale** au-dessus de la barre de transport : clic = saut,
  glisser = scrub (sans mettre en pause), survol = timecode + scène / plan / répliques
  sous le curseur. Mini-carte du projet : scènes (bandeaux bleutés), répliques (tirets
  aux couleurs des personnages), plans (traits ambre). Désactivable via
  Affichage → Barre de progression.
- **Autofocus du texte** (menu Édition, activé par défaut) : permet de désactiver le
  focus automatique du champ texte à la création d'une réplique.

### Corrections
- **Lecture : la piste audio active est désormais jouée** (le scrub le faisait déjà,
  pas la lecture) — piste embarquée ≠ 1 extraite en AAC pleine qualité (mise en cache),
  fichier externe joué directement, décalage de piste appliqué à la lecture et au
  grain de scrub.
- À l'ouverture d'un projet, le sélecteur « Piste » de l'inspecteur et le menu
  « Pistes » reflètent immédiatement le nombre de pistes du projet (il fallait
  auparavant toucher au menu « Pistes » pour les resynchroniser).

### Ajustements
- **Aimant** : le redimensionnement des répliques (bords de mots et étirement complet)
  s'aimante aussi au point de lecture et aux bords des autres répliques.
- **Nouvelle réplique** (+ Réplique, Entrée, réactions, import SRT/VTT) : placée en
  priorité sur la piste où le personnage figure déjà, sinon première piste libre.

## [2.6.1] - 2026-06-23

### Ajustements
- **Panneau du bas redimensionnable** (poignée au-dessus de la barre de transport).
- Nettoyage de l'onglet **Pistes**.

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
