// Tests du moteur : encode des animations synthétiques, les redécode (omggif) et vérifie
// timing, boucles, fusion des frames identiques, transparence et optimisation sans perte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../engine.js');
const { quantize } = require('gifenc');
const { GifReader } = require('omggif');

const W = 160, H = 90, N = 30, FPS = 25;
function frame(i, alpha = false) {
  const d = new Uint8ClampedArray(W * H * 4);
  const cx = 20 + (i / N) * 120, cy = 45;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, r = Math.hypot(x - cx, y - cy);
    if (alpha) { d[o] = 0; d[o + 1] = 32; d[o + 2] = 173; d[o + 3] = r < 15 ? 255 : 0; continue; }
    d[o] = (x / W) * 255; d[o + 1] = (y / H) * 200; d[o + 2] = 120 + 100 * Math.sin(x / 20); d[o + 3] = 255;
    if (r < 15) { d[o] = 255; d[o + 1] = 248; d[o + 2] = 232; }
  }
  return { data: d, width: W, height: H };
}
const frames = Array.from({ length: N }, (_, i) => frame(i));
const base = { colors: 256, palette: 'global', dither: 'none', strength: 0.8, bayerScale: 2, alpha: false,
  alphaThreshold: 128, matte: [255, 255, 255], optimize: false, tolerance: 0, loop: 0 };

const read = (bytes) => new GifReader(Buffer.from(bytes));
function composite(g) {
  const buf = new Uint8Array(g.width * g.height * 4), out = [];
  for (let i = 0; i < g.numFrames(); i++) { g.decodeAndBlitFrameRGBA(i, buf); out.push(buf.slice()); }
  return out;
}
const totalCs = (g) => Array.from({ length: g.numFrames() }, (_, i) => g.frameInfo(i).delay).reduce((a, b) => a + b, 0);

test('délais en centisecondes : la durée totale reste exacte', () => {
  assert.deepEqual(E.delaysFor(6, 24), [4, 4, 5, 4, 4, 4]);
  assert.equal(E.delaysFor(24, 24).reduce((a, b) => a + b), 100);
  assert.equal(E.delaysFor(30, 30).reduce((a, b) => a + b), 100);
});

for (const dither of ['none', 'bayer', 'fs', 'sierra', 'atkinson']) {
  for (const palette of ['global', 'motion', 'local']) {
    test(`décodage valide · ${dither} · palette ${palette}`, async () => {
      const r = await E.encode(frames, E.delaysFor(N, FPS), { ...base, dither, palette, colors: 64, optimize: true, tolerance: 2 }, quantize);
      const g = read(r.bytes);
      assert.equal(g.width, W); assert.equal(g.height, H);
      assert.equal(g.numFrames(), r.stats.frames);
      assert.equal(totalCs(g), N * 4);
      composite(g);
    });
  }
}

test('optimisation inter-frames sans perte à tolérance 0', async () => {
  for (const dither of ['none', 'fs', 'bayer']) {
    const full = composite(read((await E.encode(frames, E.delaysFor(N, FPS), { ...base, dither, colors: 255 }, quantize)).bytes));
    const opt = await E.encode(frames, E.delaysFor(N, FPS), { ...base, dither, colors: 256, optimize: true }, quantize);
    const o = composite(read(opt.bytes));
    assert.equal(o.length, full.length);
    o.forEach((f, i) => assert.ok(Buffer.from(f).equals(Buffer.from(full[i])), `${dither} frame ${i}`));
  }
});

test('frames identiques fusionnées, durée conservée', async () => {
  const st = Array.from({ length: 24 }, () => frame(0));
  const r = await E.encode(st, E.delaysFor(24, 24), { ...base, optimize: true }, quantize);
  const g = read(r.bytes);
  assert.equal(g.numFrames(), 1);
  assert.equal(totalCs(g), 100);
});

test('boucle : infinie, N lectures, une seule lecture', async () => {
  const enc = async (loop) => read((await E.encode(frames.slice(0, 3), E.delaysFor(3, FPS), { ...base, loop }, quantize)).bytes);
  assert.equal((await enc(0)).loopCount(), 0);
  assert.equal((await enc(3)).loopCount(), 2);
  assert.equal((await enc(1)).loopCount(), null);
});

test('transparence 1 bit', async () => {
  const af = Array.from({ length: 5 }, (_, i) => frame(i, true));
  const r = await E.encode(af, E.delaysFor(5, FPS), { ...base, alpha: true }, quantize);
  const f = composite(read(r.bytes))[2];
  let clear = 0, solid = 0;
  for (let i = 3; i < f.length; i += 4) f[i] === 0 ? clear++ : solid++;
  assert.ok(clear > 0 && solid > 0);
});

/* ---------- Lecture de structure, boucle réécrite, aplatissement ---------- */
test('gifInfo lit dimensions, frames, délais et boucle comme omggif', async () => {
  for (const optimize of [false, true]) {
    const r = await E.encode(frames, E.delaysFor(N, 24), { ...base, optimize, loop: 3 }, quantize);
    const g = read(r.bytes), info = E.gifInfo(r.bytes);
    assert.equal(info.width, W); assert.equal(info.height, H);
    assert.equal(info.frames, g.numFrames());
    assert.deepEqual(info.delays, Array.from({ length: g.numFrames() }, (_, i) => g.frameInfo(i).delay));
    assert.equal(info.loop, 3);
  }
});

test('setLoop réécrit, retire ou ajoute l’extension de boucle sans toucher aux images', async () => {
  const r = await E.encode(frames.slice(0, 6), E.delaysFor(6, FPS), { ...base, loop: 0 }, quantize);
  const ref = composite(read(r.bytes));
  for (const [loop, expected] of [[0, 0], [1, null], [2, 1], [5, 4]]) {
    const b = E.setLoop(r.bytes, loop), g = read(b);
    assert.equal(g.loopCount(), expected, `loop ${loop}`);
    assert.equal(E.gifInfo(b).loop, loop);
    composite(g).forEach((f, i) => assert.ok(Buffer.from(f).equals(Buffer.from(ref[i])), `loop ${loop} frame ${i}`));
  }
  const once = E.setLoop(r.bytes, 1);
  assert.equal(read(E.setLoop(once, 0)).loopCount(), 0);
  assert.equal(E.setLoop(E.setLoop(r.bytes, 3), 3).length, E.setLoop(r.bytes, 3).length);
});

test('flatten : alpha fusionné sur le fond, pixels opaques intacts', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 255, 200, 0, 0, 0, 0, 0, 0, 128]);
  const out = E.flatten(src, [255, 255, 255], new Uint8Array(12));
  assert.deepEqual([...out], [10, 20, 30, 255, 255, 255, 255, 255, 127, 127, 127, 255]);
});

/* ---------- gifski (WebAssembly, version mono-cœur embarquée) ---------- */
test('gifski : GIF valide, timing exact, boucle réglée après coup', async () => {
  const fs = await import('node:fs');
  const gs = await import('../vendor/gifski/gifski_wasm.js');
  gs.initSync(fs.readFileSync(new URL('../vendor/gifski/gifski_wasm_bg.wasm', import.meta.url)));
  const n = 12, buf = new Uint8Array(n * W * H * 4);
  frames.slice(0, n).forEach((f, i) => E.flatten(f.data, [255, 255, 255], buf, i * W * H * 4));
  const delays = E.delaysFor(n, 24);
  const raw = gs.encode(buf, n, W, H, undefined, new Uint32Array(delays.map((d) => d * 10)), 90, undefined, undefined, undefined);
  const g = read(raw);
  assert.equal(g.width, W); assert.equal(g.height, H);
  assert.equal(g.numFrames(), n);
  assert.equal(totalCs(g), delays.reduce((a, b) => a + b));
  assert.equal(g.loopCount(), 0);
  assert.equal(read(E.setLoop(raw, 2)).loopCount(), 1);
  composite(g);
});
