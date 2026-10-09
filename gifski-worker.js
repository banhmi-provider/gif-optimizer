/* Atelier GIF — worker gifski (module).
   Encode hors du fil principal pour garder l'interface fluide.
   Si la page est « cross-origin isolated » (npm run serve), gifski tourne sur plusieurs cœurs ;
   sinon il retombe sur la version mono-cœur. */
let ready = null;
const MAX_THREADS = 8;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const cores = (self.navigator && navigator.hardwareConcurrency) || 1;
    if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' && cores > 1) {
      try {
        const m = await import('./vendor/gifski-mt/gifski_wasm.js');
        await m.default(new URL('./vendor/gifski-mt/gifski_wasm_bg.wasm', import.meta.url));
        const threads = Math.min(cores, MAX_THREADS);
        await m.initThreadPool(threads);
        return { encode: m.encode, threads };
      } catch (e) {
        // Pas de threads exploitables : on retombe sur la version mono-cœur.
      }
    }
    const m = await import('./vendor/gifski/gifski_wasm.js');
    await m.default(new URL('./vendor/gifski/gifski_wasm_bg.wasm', import.meta.url));
    return { encode: m.encode, threads: 1 };
  })();
  return ready;
}

onmessage = async ({ data }) => {
  if (data.type === 'warm') {
    try { const a = await load(); postMessage({ type: 'ready', threads: a.threads }); }
    catch (e) { postMessage({ type: 'error', error: String((e && e.message) || e) }); }
    return;
  }
  const { id, frames, count, width, height, durations, quality } = data;
  try {
    const a = await load();
    const t0 = performance.now();
    const bytes = a.encode(frames, count, width, height, undefined, durations, quality, undefined, undefined, undefined);
    postMessage({ type: 'done', id, bytes, threads: a.threads, ms: performance.now() - t0 }, [bytes.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id, error: String((e && e.message) || e) });
  }
};
