# LibreRythmo — site vitrine

Site marketing statique, trilingue (EN / FR / ES), déployé sur **GitHub Pages**.
Séparé du code de l'application : tout vit dans `website/`.

```
website/
├── src/
│   ├── i18n/{en,fr,es}.json   ← tout le contenu marketing (une source par langue)
│   ├── assets/                ← styles.css, app.js, icône, captures, og-image
│   └── ...
├── build.mjs                  ← génère dist/ + injecte version/date/liens via l'API GitHub
├── dist/                      ← sortie générée (non commitée, déployée par l'Action)
└── README.md
```

## Développer en local

```bash
# build "preview" : base vide + origine locale, servable en HTTP
SITE_BASE='' SITE_ORIGIN='http://localhost:8099' node website/build.mjs
python -m http.server 8099 --directory website/dist
# → http://localhost:8099/  (EN)  ·  /fr/  ·  /es/
```

> ⚠️ Ouvrir `dist/index.html` en `file://` ne marche pas : les chemins d'assets
> sont absolus (`/LibreRythmo/...`). Passe toujours par un serveur HTTP.

Build de production (par défaut, celui de la CI) :

```bash
node website/build.mjs        # SITE_ORIGIN=https://fusorf.github.io  SITE_BASE=/LibreRythmo
```

## Auto-maintenance

- `build.mjs` interroge `api.github.com/repos/fusorf/LibreRythmo/releases/latest`
  et en tire **le numéro de version, la date de publication et le lien direct de
  chaque installeur** (par plateforme). Aucun lien codé en dur.
- L'Action [`pages.yml`](../.github/workflows/pages.yml) rebuild + déploie :
  à chaque **release publiée**, à chaque push sur `main` touchant `website/`,
  chaque **lundi** (filet de sécurité) et à la demande.
- En plus, `app.js` rafraîchit **en direct** version/date/liens depuis l'API
  côté visiteur (à jour même entre deux builds).
- Si l'API est injoignable au build, repli sur la version de `package.json` et
  la page `releases/latest`.

## Mise en ligne (une seule fois)

1. Repo **Settings → Pages → Source = « GitHub Actions »**.
2. Pousser sur `main` (ou lancer l'Action manuellement).
3. Site en ligne : `https://fusorf.github.io/LibreRythmo/`.

## Brancher un domaine custom plus tard

1. Acheter le domaine, créer un enregistrement DNS vers GitHub Pages.
2. Dans `pages.yml`, décommenter et adapter :
   `SITE_ORIGIN: https://librerythmo.com` et `SITE_BASE: ''`.
3. Ajouter un fichier `CNAME` (contenant le domaine) copié dans `dist/` au build,
   et déclarer le domaine dans Settings → Pages.

Aucune autre modification : tous les liens/canonical/sitemap se recalculent depuis
`SITE_ORIGIN` + `SITE_BASE`.

## Référencement (SEO / AI Overview)

- 3 URLs statiques indexables + `hreflang` (EN par défaut = `x-default`), canonical.
- JSON-LD `SoftwareApplication` (gratuit) + `FAQPage`.
- OpenGraph + Twitter Card, `sitemap.xml`, `robots.txt`.
- Détection de langue navigateur (fr → `/fr/`, es → `/es/`, autre → EN), sans
  jamais écraser un choix manuel.

## Modifier le contenu

Tout le texte est dans `src/i18n/*.json` — **une même structure de clés** dans les
trois fichiers. Modifier, rebuild, vérifier. Pour changer les captures, remplacer
les fichiers dans `src/assets/` (mêmes noms) ou ajuster les clés `img` dans le JSON.
