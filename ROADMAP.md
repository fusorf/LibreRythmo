# ROADMAP — LibreRythmo

Feuille de route à partir de la **v1.0.1**. Deux axes de travail :

1. **Conformité au standard du doublage FR** — coller aux conventions de l'industrie (réacs, boucles, voix-off, ambiances…), telles que codifiées par Cappella et l'écosystème DETX/Joker.
2. **Ingestion & automatisation** — élargir les sources (YouTube, fichiers audio externes) et automatiser la détection des mots par IA locale.

Versionnage [SemVer](https://semver.org/lang/fr/). Les jalons sont indicatifs et peuvent être réordonnés ; chaque item porte une priorité et une estimation d'effort.

---

## Légende

**Priorité** : `P0` socle métier indispensable · `P1` rattrapage de l'existant pro · `P2` extension de valeur · `P3` exploratoire / long terme.

**Effort** : `S` (< 1 j) · `M` (quelques jours) · `L` (1–2 semaines) · `XL` (chantier).

---

## État actuel (v1.0.1) — rappel

Déjà en place, à ne pas réinventer :

- Bande rythmo temps réel 1–4 pistes, élongation par mot, sync à l'image près.
- Édition souris : poignées par frontière de mot, multi-sélection, déplacement groupé, étirement proportionnel (Ctrl+bord), mode aimant.
- Personnages (nom + couleur), attribution par réplique, filtre par piste.
- Flèches d'entrée/sortie bouche ouverte/fermée → mapping DETX `in_open/in_close/out_open/out_close`. **Conforme au code des bornes de phrase Cappella.**
- Import/export DETX, SRT (+ réimport SRT corrigé sans toucher au calage), export PDF (conducteur), export MP4 composité (encodage GPU NVENC/QuickSync/AMF, repli x264).
- Projet `.rythmo` (JSON), autosave, projets récents, undo/redo, thèmes clair/sombre, UI bilingue FR/EN, détection de mise à jour GitHub.
- Mot vide `_` (silence calé), réactions standard de base (actuellement **insérées en anglais**).

Limites confirmées dans le code (`main.js`) :

- `open-video` ne renvoie que `{path, url}` → **aucune énumération des pistes audio**.
- Export : `-map '1:a?'` → **une seule piste audio**, ré-encodée AAC. Pas de sélection.
- Menu Édition réduit à Annuler/Rétablir → **pas de recherche, de copier/coller de réplique, ni de décalage global**.

---

## v1.1 — Conformité doublage FR (socle métier) · P0

L'objectif : qu'un DETX produit par LibreRythmo soit directement exploitable par un studio français.

### 1.1.1 Lexique des réacs en français · P0 · S
Remplacer les tokens anglais par le lexique FR canonique de Cappella, et respecter la **convention des parenthèses** (onomatopée = texte nu ; indication de jeu = entre parenthèses).

| Touche | Token inséré | Type |
|---|---|---|
| a | `ah` | onomatopée |
| o | `oh` | onomatopée |
| u | `euh` | onomatopée |
| f | `fff` | expiration |
| h | `hhh` | aspiration |
| H | `han !` | onomatopée |
| g | `grrr` | onomatopée |
| G | `argh !` | onomatopée |
| M | `mmm` | onomatopée |
| m | `(mts)` | claquement de lèvres |
| t | `(tst)` | claquement de langue |
| s | `(snif)` | reniflement |
| l | `(pleure)` | indication de jeu |
| p | `(peur)` | indication de jeu |
| j | `(joie)` | indication de jeu |
| i | `(rire)` | indication de jeu |
| e | `(effort)` | indication de jeu |
| c | `(course)` | indication de jeu |
| x | `(X)` | indication |
| r | `(reac)` | générique |
| ? | `(reac ?)` | générique |

Implémentation : table `reacs.js` (touche → {token, type}), localisable (l'affichage UI peut rester traduit, mais **le token écrit dans le projet/DETX doit être le FR**).

### 1.1.2 Insertion de réac en une touche · P0 · M
Au point de lecture, une pression de touche pose la réac comme **une phrase** : borne d'entrée à la position courante, texte du lexique, puis fermeture par la même touche (ou un raccourci de fin) au point de sortie. Réutilise le système de flèches entrée/sortie existant.

### 1.1.3 Respirations normalisées · P0 · S
Intégrer les conventions de souffle au lexique/aide : `hhh` (aspiration), `ffff` (expiration), `mst` (lèvres qui claquent), `tst` (langue), `(sniff)` (reniflement). Chaque respiration = une phrase bornée distincte.

### 1.1.4 Attribut voix-off · P0 · M
Ajouter un attribut `voiceOff` par réplique, rendu **souligné** sur la bande (convention : bouche non visible à l'écran). **Vérifier la survie de l'attribut dans le round-trip DETX** ; si non supporté nativement, documenter le comportement.

### 1.1.5 Couleurs par défaut conformes · P1 · S
Attribuer par défaut des **encres sombres** aux nouveaux rôles (fond de bande clair), réserver les couleurs vives/fluo aux petits rôles et ambiances. Simple changement de la palette d'auto-attribution.

---

## v1.2 — Boucles & structure de scène · P0/P1

Introduit le concept structurel le plus important encore absent.

### 1.2.1 Concept de boucles · P0 · L
Une boucle = une scène (unité de travail à l'enregistrement et au mixage). Ajouter :
- Signes/marqueurs **ouverture/fermeture de boucle** sur la timeline.
- Navigation boucle suivante/précédente (équivalent F11/F12 Cappella).
- Avertissement doux si une boucle dépasse la **durée recommandée** (~50 s, 1 min si peu chargée).
- Persistance dans le projet (voir modèle de données).

### 1.2.2 Segments « OUT » · P1 · S
Boucle spéciale `OUT` (passage sans rien à doubler), attribuée à un personnage « OUT », d'au moins 30 s, en une seule boucle même longue.

### 1.2.3 Conventions d'auteur (ambiances, ad lib, voix médias) · P1 · M
Outils/gabarits pour :
- **Réacs ad lib de scène** : bornage `(Réac ad lib ___)` au début, `(___ fin réac.)` à la fin.
- **Ambiances** : personnage « ambiance » dédié (couleur vive), type précisé (calme, scandale, cafétéria…) ; pour >4 personnages identifiés, plusieurs phrases bornées enchaînées sur une seule ligne, attribuées à des persos distincts.
- **Voix radio/TV/haut-parleur** : personnages dédiés (Radio Homme, TV Femme…), texte présent même si inaudible.

Ces conventions sont surtout des **modèles d'insertion** + des **types de personnage** ; peu de code, beaucoup de valeur métier.

---

## v1.3 — Édition avancée (rattrapage Cappella) · P1

Fonctions de confort présentes dans Cappella et absentes aujourd'hui (absence confirmée par le menu de `main.js`).

- **1.3.1 Recherche de texte** (`Ctrl+F`, navigation occurrences `F3`) · P1 · M
- **1.3.2 Copier/coller de réplique(s)** entières avec leur calage (mots + timecodes + bornes) · P1 · M
- **1.3.3 Décalage global de la bande** : offset de toutes les répliques de ±N images/ms, avec annulation · P1 · S
- **1.3.4 Photo par personnage** : champ image (chemin ou embarqué) en plus de nom+couleur ; utile au croisillé · P2 · M
- **1.3.5 Import d'une liste de rôles** : créer un projet vierge depuis les personnages d'un DETX existant (gabarit de série) · P2 · S
- **1.3.6 Lecture en vitesse lente** (25 % / 75 % avant-arrière) avec son, et **mode Shuttle** (vitesse proportionnelle à la distance du curseur). Le jog molette existe déjà via le scrub · P2 · M

---

## v1.4 — Refonte du bandeau en onglets + audio multi-pistes · P1 · XL

Refonte du bandeau du bas en **espace de travail à 3 onglets**. Absorbe les anciens besoins isolés (switch VO/VI, offset, choix des pistes à l'export).

### 1.4.1 Onglet 1 — Rythmo (défaut)
L'éditeur actuel, inchangé.

### 1.4.2 Onglet 2 — Pistes vidéo & audio · XL
Vue en lanes façon NLE :
- Affiche la piste vidéo + **toutes les pistes audio** du conteneur.
- **Offset réglable par piste** (remplace avantageusement le hack « gauche=VO / droite=VI » de Cappella).
- **Switch de la piste audio active à la lecture** (couvre le besoin VO/VI ; raccourci type `F2`).
- **Import d'un fichier audio externe** (VF témoin, musique, voix enregistrée à part) déposé puis **glissé sur la timeline pour le caler**.
- **Choix des pistes à l'export** depuis cette vue (case par piste + piste par défaut).

### 1.4.3 Refonte technique `main.js` · L
- IPC `probe-audio-tracks` (via ffprobe/ffmpeg) : index, langue, titre, nb de canaux.
- **Lecture audio découplée** : Chromium ne bascule pas fiablement la piste d'un fichier multiplexé. Extraire chaque piste vers des fichiers temp (`-map 0:a:N`) et jouer via un `<audio>` synchronisé sur `video.currentTime` (vidéo `muted`).
- Export : remplacer `-map '1:a?'` par un mapping dynamique (`-map 1:a:0 -map 1:a:1 …`), `-c:a copy` si compatible MP4 sinon repli AAC, conservation langue/disposition par piste, application des offsets.

---

## v1.5 — Ingestion YouTube · P2 · M

- Embarquer **yt-dlp** comme binaire (logique `ffmpeg-static`).
- Dialogue « Ouvrir depuis une URL… » → **téléchargement** vers un fichier temp/cache (pas de streaming : tout le pipeline suppose un fichier local), puis réinjection dans `open-video`.
- Forcer un conteneur compatible (mp4 / H.264 + AAC) pour ne pas hériter de VP9/Opus.
- Récupérer les **pistes audio multilingues** quand elles existent → alimente l'onglet 2.
- **Stratégie de mise à jour** du binaire yt-dlp (l'extraction YouTube casse souvent).
- **Note légale** dans l'UI : usage destiné au contenu sur lequel l'utilisateur détient les droits.

---

## v2.0 — Détection automatique des mots (IA locale) · P2/P3 · XL

Onglet 3. Équivalent moderne de la détection Cappella, et alignement parfait avec le modèle de données (chaque mot porte déjà `start`/`end`).

### 2.0.1 Onglet 3 — ASR local
- **Modèle** : `whisper.cpp` (ggml) embarquable sans Python, timestamps au token — le plus propre pour Electron. Alternative plus précise : `WhisperX` (alignement forcé wav2vec2) mais dépendance Python. Large-v3 efficace en FR.
- Téléchargement séparé des modèles (lourds), choix de la taille, GPU optionnel.
- ASR sur **une piste audio choisie** (depuis l'onglet 2) → mots + positions.

### 2.0.2 Transfert vers la bande rythmo
- Cible : **une piste donnée** de l'onglet 1, peuplant `words[{text,start,end}]`.
- Deux modes :
  - **Mots + positions** (transcription/calage de la VO).
  - **Positions seules** comme gabarit de synchro — le texte adapté est saisi par-dessus (l'ASR transcrit la langue d'origine, alors qu'en doublage on réécrit le texte).

### 2.0.3 Détection automatique des changements de plan · P2 · M
Via le détecteur de scènes ffmpeg (`select='gt(scene,seuil)'`), seuil réglable, pose de marqueurs de changement de plan. Peut être livré indépendamment.

---

## Hors périmètre / à étudier

- **Détection phonétique au signe** (labiales, dentales, cul-de-poule, ouvertures…) : choix d'architecture lourd. Le modèle « au mot » de LibreRythmo est un parti pris assumé. À reconsidérer seulement si une cible studio l'exige.
- **Couplage matériel Orphée** : matériel propriétaire, hors scope open source.
- **Workflow MJPEG** : non pertinent — LibreRythmo gère MP4 nativement via ffmpeg (déjà supérieur sur ce point).

---

## Évolution du modèle de données (transversal)

Bump de `version` du projet, avec **rétrocompatibilité** (les anciens `.rythmo`/`.json` avec `videoPath` se rouvrent).

```jsonc
{
  "version": 2,
  "sources": {
    "video": { "path": "…/film.mp4" },
    "audioTracks": [
      {
        "id": "…",
        "source": { "type": "embedded", "index": 0 },   // ou { "type": "file", "path": "…" }
        "offset": 0.0,        // secondes ; appliqué en lecture ET à l'export
        "label": "VO",
        "gain": 1.0,
        "exported": true,     // inclus dans l'export MP4
        "isDefault": true
      }
    ]
  },
  "fps": 25,
  "tracks": 1,
  "loops": [
    { "id": "…", "start": 0.0, "end": 48.0, "name": "Scène 1", "type": "normal" }  // type: "normal" | "out"
  ],
  "characters": [
    { "id": "…", "name": "Emma", "color": "#3a2f2f", "photo": null, "role": "main" }  // role: "main"|"ambiance"|"media"|"out"
  ],
  "lines": [
    {
      "id": "…",
      "characterId": "…",
      "track": 0,
      "entry": "closed",       // existant
      "exit": "open",          // existant
      "voiceOff": false,       // NOUVEAU — rendu souligné
      "kind": "dialogue",      // NOUVEAU — "dialogue"|"reac"|"ambiance"
      "words": [ { "text": "Bonjour", "start": 1.24, "end": 1.81 } ]
    }
  ]
}
```

---

## Points à trancher

1. **Offset audio** : purement preview, ou gravé à l'export ? (proposition : les deux, stocké dans le projet.)
2. **Voix-off & DETX** : l'attribut souligné survit-il au round-trip DETX, ou reste-t-il interne à `.rythmo` ?
3. **Boucles & DETX** : comment sérialiser les bornes de boucle dans le DETX pour rester interopérable avec Cappella/Joker ?
4. **ASR** : whisper.cpp (zéro dépendance, autonome) vs WhisperX (plus précis, dépend de Python) — choix selon la cible de précision et la complexité d'empaquetage.
5. **Transfert ASR** : comportement par défaut = « mots + positions » ou « positions seules » ?
6. **YouTube** : cache persistant des téléchargements ou purge à la fermeture du projet ?

---

## Nouvelles dépendances techniques

| Dépendance | Usage | Jalon | Licence à vérifier |
|---|---|---|---|
| ffprobe (déjà fourni avec ffmpeg) | énumération pistes audio | v1.4 | — |
| yt-dlp (binaire) | ingestion YouTube | v1.5 | Unlicense / domaine public |
| whisper.cpp (+ modèles ggml) | ASR local | v2.0 | MIT (modèles : à vérifier) |

---

## Synthèse des priorités

```
P0  v1.1 (réacs FR, insertion 1 touche, respirations, voix-off)  →  v1.2 (boucles, OUT)
P1  v1.2 (conventions ambiances/ad lib)  →  v1.3 (recherche, copier/coller, décalage)  →  v1.4 (onglets + audio multi-pistes)
P2  v1.5 (YouTube)  →  v2.0 (ASR, détection de plans)
P3  détection phonétique au signe (à reconsidérer)
```

_Document de travail — © 2026 fusorf, licence GPL-3.0-or-later (au même titre que le projet)._
