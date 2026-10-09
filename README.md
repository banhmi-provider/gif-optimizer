# Atelier GIF

Convertisseur vidéo → GIF réglable, dans l'esprit de GifGun, qui tourne entièrement dans le navigateur : décodage, quantification et encodage se font en local, aucun fichier n'est envoyé.

## Utilisation

Ouvre `index.html` via un serveur local (`npm run serve`, puis http://localhost:8080), ou publie le dossier sur GitHub Pages. Dépose une vidéo ou une séquence d'images, règle, encode, télécharge.

**Formats lus** : ce que le navigateur décode, soit H.264, HEVC, VP9/WebM (alpha compris), AV1, et les séquences PNG/JPG/WebP. Chrome ne lit pas le ProRes : exporte depuis After Effects en H.264, en WebM ou en séquence PNG (la séquence garde l'alpha).

## Réglages

| Groupe | Réglages |
|---|---|
| Sortie | largeur, mise à l'échelle (lisse ou pixel net), images/s (1 à 50), vitesse, sens (avant, arrière, boomerang), boucle (infinie ou N lectures), entrée/sortie |
| Couleurs | 2 à 256 couleurs ; palette globale, « mouvement » ou par frame ; dithering aucun, Bayer (échelle 0–5), Floyd–Steinberg, Sierra Lite, Atkinson (intensité réglable) |
| Transparence | alpha 1 bit avec seuil, couleur de fond (matte) pour les bords semi-transparents |
| Compression | optimisation inter-frames (rectangle modifié + pixels inchangés transparents), fusion des frames identiques, tolérance |
| Presets | presets intégrés, presets perso enregistrés dans le navigateur, export/import `.json` |

L'aperçu applique la vraie chaîne d'encodage sur la frame courante (zoom 100 % / 200 % pour juger le dithering). Après un premier encodage, les frames extraites restent en cache : changer couleurs, dithering ou compression ré-encode sans ré-extraire.

## Notes d'encodage

- **Timing** : le GIF compte en centisecondes. Les navigateurs remontent un délai de 0 ou 1 cs à 10 cs, d'où le plafond de 50 i/s. Pour 24 ou 30 i/s, les délais alternent (4/4/5 cs) afin de garder la durée exacte.
- **Palette** : 256 couleurs maximum par frame. La palette globale évite le scintillement ; « mouvement » calcule la palette sur les pixels qui changent (utile pour les fonds fixes) ; « par frame » donne plus de couleurs au total mais pèse plus lourd.
- **Dithering** : Bayer produit une trame stable d'une frame à l'autre et se compresse bien avec l'optimisation inter-frames. La diffusion d'erreur (Floyd–Steinberg, Sierra Lite, Atkinson) adoucit les dégradés mais fait « bouger » le grain, donc le fichier grossit. L'échelle Bayer reprend la convention de `paletteuse` de ffmpeg.
- **Optimisation inter-frames** : à tolérance 0 elle est sans perte (les frames recomposées sont identiques au pixel près). Elle est désactivée avec la transparence, chaque frame étant alors réécrite en entier.

## Structure

- `index.html` : interface (HTML, CSS, JS sans build)
- `engine.js` : moteur sans DOM (composite alpha, dithering, palettes, optimisation, LZW, écriture GIF89a), utilisable dans le navigateur et dans Node
- `test/run.mjs` : tests (encodage puis décodage avec omggif)

La quantification utilise [gifenc](https://github.com/mattdesl/gifenc) (MIT), chargé depuis jsDelivr.

## Tests

```sh
npm install
npm test
```
