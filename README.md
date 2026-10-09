# Atelier GIF

Convertisseur vidéo → GIF réglable, dans l'esprit de GifGun, qui tourne entièrement dans le navigateur. Trois chaînes d'encodage au choix, toutes locales : aucun fichier n'est envoyé.

| Chaîne | Ce qu'elle fait | Quand l'utiliser |
|---|---|---|
| **Atelier** | Moteur maison : palette, dithering, optimisation inter-frames réglables, aperçu fidèle frame par frame | UI, aplats, pixel art, contrôle fin, itérations rapides |
| **gifski** | [gifski](https://gif.ski) compilé en WebAssembly : palettes inter-frames et dithering temporel de pngquant, des milliers de couleurs par frame | Dégradés, footage, motion « riche » : la meilleure qualité |
| **+ gifsicle** | Passe finale [gifsicle](https://www.lcdf.org/gifsicle/) `-O3 --lossy=N` sur le GIF produit | Gagner 20 à 40 % de poids avant Slack, Notion, email |

Le **banc d'essai** garde les 10 derniers encodages (chaîne, réglages, taille, écart, temps). **Comparer les 3 moteurs** encode le même extrait avec Atelier, gifski, puis gifski + gifsicle, et met en vert le plus léger.

## Utilisation

```sh
npm run serve        # puis http://localhost:8080
```

Le serveur (`serve.mjs`, sans dépendance) envoie les en-têtes COOP/COEP : la page est « cross-origin isolated », donc **gifski tourne sur plusieurs cœurs** dans Chrome, Edge et Firefox. Sans eux (autre serveur statique, GitHub Pages, Safari), gifski retombe sur un seul cœur, plus lent mais identique en sortie. Ouvrir `index.html` en `file://` ne marche pas : les navigateurs y bloquent modules et workers.

Dépose une vidéo ou une séquence d'images, règle, encode, télécharge.

**Formats lus** : ce que le navigateur décode, soit H.264, HEVC, VP9/WebM (alpha compris), AV1, et les séquences PNG/JPG/WebP. Chrome ne lit pas le ProRes : exporte depuis After Effects en H.264, en WebM ou en séquence PNG (la séquence garde l'alpha).

## Réglages

| Groupe | Réglages |
|---|---|
| Moteur | Atelier ou gifski ; qualité gifski 1–100 |
| Sortie | largeur, mise à l'échelle (lisse ou pixel net), images/s (1 à 50), vitesse, sens (avant, arrière, boomerang), boucle (infinie ou N lectures), entrée/sortie |
| Couleurs (Atelier) | 2 à 256 couleurs ; palette globale, « mouvement » ou par frame ; dithering aucun, Bayer (échelle 0–5), Floyd–Steinberg, Sierra Lite, Atkinson (intensité réglable) |
| Transparence | alpha conservé (1 bit avec seuil pour Atelier, géré par gifski sinon), couleur de fond (matte) pour les bords semi-transparents |
| Compression (Atelier) | optimisation inter-frames (rectangle modifié + pixels inchangés transparents), fusion des frames identiques, tolérance |
| Passe finale | gifsicle `-O3`, lossy 0–200 |
| Presets | presets intégrés (dont gifski et gifski + lossy), presets perso enregistrés dans le navigateur, export/import `.json` |

Avec Atelier, l'aperçu applique la vraie chaîne d'encodage sur la frame courante (zoom 100 % / 200 % pour juger le dithering). gifski n'a pas d'aperçu par frame : on encode pour juger. Après un premier encodage, les frames extraites restent en cache : changer de moteur ou de réglages ré-encode sans ré-extraire.

## Notes d'encodage

- **Timing** : le GIF compte en centisecondes. Les navigateurs remontent un délai de 0 ou 1 cs à 10 cs, d'où le plafond de 50 i/s. Pour 24 ou 30 i/s, les délais alternent (4/4/5 cs) afin de garder la durée exacte. gifski reçoit les mêmes délais en millisecondes et les respecte.
- **Boucle** : gifski écrit toujours une boucle infinie ; l'outil réécrit ensuite l'extension NETSCAPE selon le réglage (`setLoop` dans `engine.js`).
- **gifski** : sa qualité vient de palettes partagées entre frames et d'un dithering temporel. Le prix : un encodage plusieurs fois plus long qu'Atelier, et 480 Mo de frames au maximum dans le navigateur.
- **gifsicle lossy** : 20–40 reste quasi invisible ; au-delà de 80, le grain se voit. Si la passe n'allège pas le fichier, l'outil garde la version précédente.
- **Palette (Atelier)** : 256 couleurs maximum par frame. La palette globale évite le scintillement ; « mouvement » calcule la palette sur les pixels qui changent ; « par frame » donne plus de couleurs au total mais pèse plus lourd.
- **Dithering (Atelier)** : Bayer produit une trame stable d'une frame à l'autre et se compresse bien avec l'optimisation inter-frames. La diffusion d'erreur (Floyd–Steinberg, Sierra Lite, Atkinson) adoucit les dégradés mais fait « bouger » le grain, donc le fichier grossit.
- **Optimisation inter-frames (Atelier)** : à tolérance 0 elle est sans perte (les frames recomposées sont identiques au pixel près). Elle est désactivée avec la transparence.

## Structure

- `index.html` : interface (HTML, CSS, JS sans build)
- `engine.js` : moteur Atelier sans DOM (composite alpha, dithering, palettes, optimisation, LZW, écriture GIF89a) + lecture de structure GIF, réécriture de boucle ; utilisable dans le navigateur et dans Node
- `gifski-worker.js` : worker qui encode avec gifski hors du fil principal (multi-cœurs si la page est isolée)
- `serve.mjs` : serveur local avec les en-têtes COOP/COEP
- `vendor/` : dépendances embarquées, aucune requête réseau à l'encodage
  - `gifenc/` : quantification d'Atelier ([gifenc](https://github.com/mattdesl/gifenc), MIT)
  - `gifski/`, `gifski-mt/` : [gifski-wasm](https://github.com/jamsinclair/gifski-wasm) 2.2.0, versions mono et multi-cœurs (AGPL-3.0, sources : [gifski](https://github.com/ImageOptim/gifski)). L'import du worker rayon est corrigé pour fonctionner sans bundler.
  - `gifsicle/` : [gifsicle-wasm-browser](https://github.com/renzhezhilu/gifsicle-wasm-browser) 1.5.19 (MIT ; gifsicle 1.92)
- `test/run.mjs` : tests Node (encodage puis décodage avec omggif, gifski compris)

## Tests

```sh
npm install
npm test
```

## Licence

gifski est sous AGPL-3.0 : si tu distribues ou héberges l'outil publiquement, le code source doit rester accessible (ce dépôt suffit, avec les liens ci-dessus).
