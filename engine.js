/* Atelier GIF — moteur d'encodage (pur JS, sans DOM).
   Quantification via gifenc.quantize (injectée), le reste ici :
   composite/alpha, dithering (Bayer, Floyd–Steinberg, Sierra Lite, Atkinson),
   palettes globales/mouvement/par frame, optimisation inter-frames
   (rectangle + transparence + fusion des frames identiques), LZW, écriture GIF89a. */
const GifEngine = (() => {
  class Writer {
    constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.len = 0; }
    grow(n) {
      if (this.len + n <= this.buf.length) return;
      let c = this.buf.length * 2;
      while (c < this.len + n) c *= 2;
      const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.len)); this.buf = b;
    }
    byte(v) { this.grow(1); this.buf[this.len++] = v; }
    u16(v) { this.grow(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255; }
    bytes(a) { this.grow(a.length); this.buf.set(a, this.len); this.len += a.length; }
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    result() { return this.buf.slice(0, this.len); }
  }

  /* ---------- LZW (variante GIF, « late change », table 4096 codes) ---------- */
  const DICT = new Int32Array(4096 * 256);
  let gen = 0;
  function nextGen() { gen++; if (gen > 0x7ffff) { DICT.fill(0); gen = 1; } }

  function lzw(w, idx, minCodeSize) {
    const clear = 1 << minCodeSize, eoi = clear + 1;
    let size = minCodeSize + 1, maxcode = (1 << size) - 1, next = clear + 2;
    let acc = 0, bits = 0, clearFlag = false;
    const block = new Uint8Array(255); let blen = 0;
    const flush = () => { if (blen) { w.byte(blen); w.bytes(blen === 255 ? block : block.subarray(0, blen)); blen = 0; } };
    const emit = (code) => {
      acc |= code << bits; bits += size;
      while (bits >= 8) { block[blen++] = acc & 255; acc >>>= 8; bits -= 8; if (blen === 255) flush(); }
      if (next > maxcode || clearFlag) {
        if (clearFlag) { size = minCodeSize + 1; maxcode = (1 << size) - 1; clearFlag = false; }
        else { size++; maxcode = size === 12 ? 4096 : (1 << size) - 1; }
      }
    };
    w.byte(minCodeSize);
    nextGen();
    emit(clear);
    let prefix = idx[0];
    for (let i = 1, n = idx.length; i < n; i++) {
      const k = idx[i];
      const key = (prefix << 8) | k;
      const v = DICT[key];
      if ((v >>> 12) === gen) { prefix = v & 4095; continue; }
      emit(prefix);
      if (next < 4096) { DICT[key] = (gen << 12) | next; next++; }
      else { clearFlag = true; next = clear + 2; emit(clear); nextGen(); }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (bits > 0) { block[blen++] = acc & 255; if (blen === 255) flush(); }
    flush();
    w.byte(0);
  }

  /* ---------- Correspondance couleur (redmean + cache 18 bits) ---------- */
  function makeMapper(pal, n) {
    const cache = new Int16Array(1 << 18).fill(-1);
    return (r, g, b) => {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      const c = cache[key];
      if (c >= 0) return c;
      const R = (r & 252) + 2, G = (g & 252) + 2, B = (b & 252) + 2;
      let best = 0, bd = Infinity;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const pr = pal[j], dr = R - pr, dg = G - pal[j + 1], db = B - pal[j + 2];
        const rm = (R + pr) >> 1;
        const d = (((512 + rm) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rm) * db * db) >> 8);
        if (d < bd) { bd = d; best = i; }
      }
      cache[key] = best;
      return best;
    };
  }

  /* ---------- Préparation : composite sur le fond, masque alpha 1 bit ---------- */
  function prepare(rgba, w, h, opt) {
    const n = w * h, rgb = new Uint8Array(n * 3);
    const mask = opt.alpha ? new Uint8Array(n) : null;
    const [mr, mg, mb] = opt.matte, thr = opt.alphaThreshold;
    for (let p = 0, s = 0, d = 0; p < n; p++, s += 4, d += 3) {
      const a = rgba[s + 3];
      if (mask && a < thr) { mask[p] = 1; rgb[d] = mr; rgb[d + 1] = mg; rgb[d + 2] = mb; continue; }
      if (a === 255) { rgb[d] = rgba[s]; rgb[d + 1] = rgba[s + 1]; rgb[d + 2] = rgba[s + 2]; }
      else {
        const t = a / 255, u = 1 - t;
        rgb[d] = rgba[s] * t + mr * u + 0.5;
        rgb[d + 1] = rgba[s + 1] * t + mg * u + 0.5;
        rgb[d + 2] = rgba[s + 2] * t + mb * u + 0.5;
      }
    }
    return { rgb, mask, w, h };
  }

  /* ---------- Dithering ---------- */
  const BAYER8 = [0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,
    3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];
  const KERNELS = {
    fs: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
    sierra: [[1, 0, 2 / 4], [-1, 1, 1 / 4], [0, 1, 1 / 4]],
    atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  };
  let work = new Float32Array(0);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  function mapFrame(fr, pal, map, opt, T) {
    const { rgb, mask, w, h } = fr, n = w * h, out = new Uint8Array(n);
    const mode = opt.dither;
    if (mode === 'none') {
      for (let p = 0, d = 0; p < n; p++, d += 3) out[p] = mask && mask[p] ? T : map(rgb[d], rgb[d + 1], rgb[d + 2]);
      return out;
    }
    if (mode === 'bayer') {
      const s = opt.bayerScale, delta = 1 << (5 - s);
      for (let y = 0, p = 0; y < h; y++) {
        const row = (y & 7) * 8;
        for (let x = 0; x < w; x++, p++) {
          if (mask && mask[p]) { out[p] = T; continue; }
          const o = (BAYER8[row + (x & 7)] >> s) - delta, d = p * 3;
          out[p] = map(clamp(rgb[d] + o), clamp(rgb[d + 1] + o), clamp(rgb[d + 2] + o));
        }
      }
      return out;
    }
    const K = KERNELS[mode] || KERNELS.fs, st = opt.strength;
    if (work.length < n * 3) work = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) work[i] = rgb[i];
    for (let y = 0; y < h; y++) {
      const rev = y & 1;
      for (let xi = 0; xi < w; xi++) {
        const x = rev ? w - 1 - xi : xi, p = y * w + x;
        if (mask && mask[p]) { out[p] = T; continue; }
        const d = p * 3;
        const r = clamp(work[d]), g = clamp(work[d + 1]), b = clamp(work[d + 2]);
        const c = map(r | 0, g | 0, b | 0);
        out[p] = c;
        const er = (r - pal[c * 3]) * st, eg = (g - pal[c * 3 + 1]) * st, eb = (b - pal[c * 3 + 2]) * st;
        for (let k = 0; k < K.length; k++) {
          const nx = x + (rev ? -K[k][0] : K[k][0]), ny = y + K[k][1];
          if (nx < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask && mask[q]) continue;
          const wt = K[k][2], qd = q * 3;
          work[qd] += er * wt; work[qd + 1] += eg * wt; work[qd + 2] += eb * wt;
        }
      }
    }
    return out;
  }

  /* ---------- Palette ---------- */
  const BUDGET = 1500000;
  function sampleFrames(frames, mode) {
    const total = frames.reduce((s, f) => s + f.w * f.h, 0);
    const stride = Math.max(1, Math.ceil(total / BUDGET));
    const parts = [];
    let count = 0;
    frames.forEach((f, i) => {
      const n = f.w * f.h, prev = mode === 'motion' && i > 0 ? frames[i - 1].rgb : null;
      const buf = new Uint8Array(Math.ceil(n / stride) * 4);
      let k = 0;
      for (let p = (i * 7) % stride; p < n; p += stride) {
        if (f.mask && f.mask[p]) continue;
        const d = p * 3;
        if (prev) {
          const diff = Math.abs(f.rgb[d] - prev[d]) + Math.abs(f.rgb[d + 1] - prev[d + 1]) + Math.abs(f.rgb[d + 2] - prev[d + 2]);
          if (diff < 24) continue;
        }
        buf[k++] = f.rgb[d]; buf[k++] = f.rgb[d + 1]; buf[k++] = f.rgb[d + 2]; buf[k++] = 255;
      }
      parts.push(buf.subarray(0, k)); count += k;
    });
    const all = new Uint8Array(count);
    let o = 0;
    for (const part of parts) { all.set(part, o); o += part.length; }
    return all;
  }

  function buildPalette(samples, maxColors, quantize) {
    if (samples.length < 4) return new Uint8Array([0, 0, 0]);
    const pal = quantize(samples, Math.max(1, maxColors), { format: 'rgb565' });
    const flat = new Uint8Array(pal.length * 3);
    pal.forEach((c, i) => { flat[i * 3] = c[0]; flat[i * 3 + 1] = c[1]; flat[i * 3 + 2] = c[2]; });
    return flat;
  }

  function colorTable(pal, needT) {
    const n = pal.length / 3, used = n + (needT ? 1 : 0);
    const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, used))));
    const table = new Uint8Array((1 << bits) * 3);
    table.set(pal);
    return { table, bits, T: needT ? n : -1, n };
  }

  /* ---------- Délais : timeline exacte en centisecondes ---------- */
  function delaysFor(count, fps) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));
    return out;
  }

  /* ---------- Encodage complet ---------- */
  async function encode(frames, delays, opt, quantize, hooks = {}) {
    const tick = hooks.tick || (async () => {});
    const progress = hooks.progress || (() => {});
    const w = frames[0].width, h = frames[0].height, N = frames.length;
    const optimize = opt.optimize && !opt.alpha;
    const needT = opt.alpha || optimize;
    const maxC = Math.max(2, Math.min(256, opt.colors)) - (needT ? 1 : 0);

    const prepared = [];
    for (let i = 0; i < N; i++) {
      prepared.push(prepare(frames[i].data, w, h, opt));
      if (i % 8 === 0) { progress(0.15 * (i / N), 'Préparation'); await tick(); }
    }

    let global = null;
    if (opt.palette !== 'local') {
      progress(0.16, 'Palette');
      await tick();
      let samples = sampleFrames(prepared, opt.palette);
      if (opt.palette === 'motion' && samples.length < 4096) samples = sampleFrames(prepared, 'global');
      const pal = buildPalette(samples, maxC, quantize);
      global = { pal, ...colorTable(pal, needT), map: makeMapper(pal, pal.length / 3) };
    }

    const W = new Writer(Math.max(1 << 16, (w * h * N) >> 2));
    W.str('GIF89a');
    W.u16(w); W.u16(h);
    W.byte(global ? 0xf0 | (global.bits - 1) : 0x70);
    W.byte(0); W.byte(0);
    if (global) W.bytes(global.table);
    if (opt.loop !== 1) {
      W.byte(0x21); W.byte(0xff); W.byte(11); W.str('NETSCAPE2.0');
      W.byte(3); W.byte(1); W.u16(opt.loop === 0 ? 0 : opt.loop - 1); W.byte(0);
    }

    const dispose = opt.alpha ? 2 : 1;
    const writeFrame = (f) => {
      W.byte(0x21); W.byte(0xf9); W.byte(4);
      W.byte((dispose << 2) | (f.T >= 0 ? 1 : 0));
      W.u16(Math.min(65535, f.delay)); W.byte(f.T >= 0 ? f.T : 0); W.byte(0);
      W.byte(0x2c); W.u16(f.x); W.u16(f.y); W.u16(f.w); W.u16(f.h);
      if (f.local) { W.byte(0x80 | (f.local.bits - 1)); W.bytes(f.local.table); } else W.byte(0);
      lzw(W, f.idx, Math.max(2, (f.local || global).bits));
    };

    const shown = optimize ? new Uint8Array(w * h * 3) : null;
    const tol2 = (opt.tolerance || 0) ** 2;
    let pending = null, written = 0, merged = 0;
    for (let i = 0; i < N; i++) {
      if (hooks.cancelled && hooks.cancelled()) throw new Error('cancelled');
      const fr = prepared[i];
      let ctx = global;
      if (!ctx) {
        const pal = buildPalette(sampleFrames([fr], 'global'), maxC, quantize);
        ctx = { pal, ...colorTable(pal, needT), map: makeMapper(pal, pal.length / 3) };
      }
      const idx = mapFrame(fr, ctx.pal, ctx.map, opt, ctx.T);
      let rec;
      if (optimize && i > 0) {
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        const changed = new Uint8Array(w * h);
        for (let y = 0, p = 0; y < h; y++) {
          for (let x = 0; x < w; x++, p++) {
            const c = idx[p] * 3, d = p * 3;
            const dr = ctx.pal[c] - shown[d], dg = ctx.pal[c + 1] - shown[d + 1], db = ctx.pal[c + 2] - shown[d + 2];
            if (dr * dr + dg * dg + db * db > tol2) {
              changed[p] = 1;
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) { pending.delay += delays[i]; merged++; continue; }
        const fw = x1 - x0 + 1, fh = y1 - y0 + 1, sub = new Uint8Array(fw * fh);
        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const p = (y + y0) * w + x + x0;
            if (changed[p]) {
              sub[y * fw + x] = idx[p];
              const c = idx[p] * 3, d = p * 3;
              shown[d] = ctx.pal[c]; shown[d + 1] = ctx.pal[c + 1]; shown[d + 2] = ctx.pal[c + 2];
            } else sub[y * fw + x] = ctx.T;
          }
        }
        rec = { x: x0, y: y0, w: fw, h: fh, idx: sub };
      } else {
        rec = { x: 0, y: 0, w, h, idx };
        if (optimize) for (let p = 0; p < w * h; p++) { const c = idx[p] * 3, d = p * 3; shown[d] = ctx.pal[c]; shown[d + 1] = ctx.pal[c + 1]; shown[d + 2] = ctx.pal[c + 2]; }
      }
      rec.delay = delays[i];
      rec.T = ctx.T;
      rec.local = global ? null : ctx;
      if (pending) { writeFrame(pending); written++; }
      pending = rec;
      progress(0.18 + 0.82 * ((i + 1) / N), 'Encodage');
      await tick();
    }
    writeFrame(pending); written++;
    W.byte(0x3b);
    const bytes = W.result();
    return {
      bytes,
      stats: { width: w, height: h, frames: written, merged, colors: global ? global.n : maxC, palette: global ? global.pal : null,
        durationCs: delays.reduce((a, b) => a + b, 0) },
    };
  }

  /* ---------- Aperçu d'une frame (même chaîne que l'export) ---------- */
  function previewFrame(rgba, w, h, opt, quantize, palette) {
    const fr = prepare(rgba, w, h, opt);
    const needT = opt.alpha || (opt.optimize && !opt.alpha);
    const maxC = Math.max(2, Math.min(256, opt.colors)) - (needT ? 1 : 0);
    const pal = palette || buildPalette(sampleFrames([fr], 'global'), maxC, quantize);
    const n = pal.length / 3, T = opt.alpha ? n : -1;
    const idx = mapFrame(fr, pal, makeMapper(pal, n), opt, T);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const o = p * 4;
      if (idx[p] === T) { out[o + 3] = 0; continue; }
      const c = idx[p] * 3;
      out[o] = pal[c]; out[o + 1] = pal[c + 1]; out[o + 2] = pal[c + 2]; out[o + 3] = 255;
    }
    return { data: out, palette: pal };
  }

  /* Palette globale telle que l'export la calculera (pour l'aperçu) */
  function globalPalette(frames, opt, quantize) {
    const w = frames[0].width, h = frames[0].height;
    const prepared = frames.map((f) => prepare(f.data, w, h, opt));
    const needT = opt.alpha || (opt.optimize && !opt.alpha);
    const maxC = Math.max(2, Math.min(256, opt.colors)) - (needT ? 1 : 0);
    let samples = sampleFrames(prepared, opt.palette);
    if (opt.palette === 'motion' && samples.length < 4096) samples = sampleFrames(prepared, 'global');
    return buildPalette(samples, maxC, quantize);
  }

  return { encode, previewFrame, globalPalette, delaysFor, prepare, mapFrame, makeMapper, lzw, Writer };
})();
if (typeof module !== 'undefined') module.exports = GifEngine;
