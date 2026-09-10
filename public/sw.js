/**
 * Madhurita's service worker.
 *
 * ## The one rule that matters
 *
 * **Nothing under `/api/` is ever cached, and nothing under `/api/` is ever served from
 * a cache.** Not the state snapshot, not the transcript, not the environment, and
 * certainly not the stream.
 *
 * This is not a performance decision, it is the honesty contract applied to the network
 * layer. Every other part of this application is built so that a stale picture reports
 * its own staleness — `presence` drains and dims her when the stream goes away, the
 * whisper line says what she is actually doing, the Ledger says what she cannot prove.
 * A service worker that answered `GET /api/state` out of a cache would defeat all of it
 * at once: the room would come up bright and warm, showing a conversation from
 * yesterday, with nothing anywhere on screen able to tell that it was not now. So those
 * requests are not intercepted at all — this file does not call `respondWith` for them,
 * which leaves the browser's own network path untouched. That also keeps the worker out
 * of the way of `GET /api/stream`, which is an `EventSource`: a service worker that
 * proxies a long-lived streaming response can buffer it, and a buffered event stream is
 * a presence layer that updates in bursts or never.
 *
 * The consequence, stated plainly: **offline, she is unreachable.** The shell loads, the
 * first API call fails, and the interface says so. That is the true thing to say.
 *
 * ## What is cached, and why that is safe
 *
 * - **The shell** (`/`) — network-first. A deploy is picked up the moment the network
 *   allows; the cached copy is only used when the network fails. Every navigation falls
 *   back to the same cached `/` because the client is a single-page app.
 * - **Build output** (`/assets/*`) — cache-first. Vite gives these content-hashed
 *   filenames, so a given URL's bytes can never change; serving them from a cache is
 *   not a staleness risk, it is the definition of an immutable asset.
 * - **Icons and the manifest** — cache-first. Same reasoning, weaker guarantee: these
 *   paths are stable rather than hashed, so a changed icon arrives on the next `VERSION`
 *   bump rather than immediately. That is an acceptable trade for an icon.
 *
 * Nothing is precached beyond `/` and those stable paths, because the hashed asset names
 * are only known at build time and a hand-written list of them would go stale silently —
 * the failure this repo treats as the worst kind. The cost is that the *first* visit
 * warms the caches and the *second* visit is the first one that works offline.
 *
 * ## Version and cleanup
 *
 * Bumping `VERSION` renames both caches, so the previous generation is deleted wholesale
 * on the next activation. That is also the only thing that clears superseded hashed
 * assets, since nothing here can know which hashes are still current.
 */

const VERSION = 'madhurita-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const CACHES = [SHELL_CACHE, ASSET_CACHE];

/** The single document this client has. Every navigation resolves to it. */
const SHELL_URL = '/';

/** Stable paths worth holding. Hashed build output is cached on demand instead. */
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

/** Cache-first is only ever correct for these. Everything else goes to the network. */
function isImmutable(pathname) {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await self.caches.open(SHELL_CACHE);
      // Individually, and tolerantly: one missing icon must not fail the whole install
      // and leave the page with no worker at all.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            const response = await fetch(path, { cache: 'reload' });
            if (response.ok) await cache.put(path, response);
          } catch {
            // Offline during install. The next fetch will warm it.
          }
        }),
      );
      // Take over as soon as the old worker lets go. Safe here because the shell is
      // network-first and the assets are content-hashed, so there is no combination of
      // old page and new worker that can serve mismatched bytes.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await self.caches.keys();
      await Promise.all(names.filter((name) => !CACHES.includes(name)).map((name) => self.caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/**
 * The document, newest first.
 *
 * Keyed on `SHELL_URL` rather than on the request, so `/anything` offline still gets the
 * one shell rather than a miss.
 */
async function shell(request) {
  const cache = await self.caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.status === 200) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached !== undefined) return cached;
    return unreachable();
  }
}

/** An immutable asset. Cached on first sight, then never fetched again. */
async function immutable(request) {
  const cache = await self.caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  // 200 only: a 206 is a fragment and a redirect is not the asset.
  if (response.status === 200) await cache.put(request, response.clone());
  return response;
}

/**
 * The last resort: offline, on a device that has never loaded her.
 *
 * Deliberately not in her colours. Her palette means "this is Madhurita, and this is
 * the hour and the sky she can see" — painting a page that failed to reach her in it
 * would be the small lie this whole file exists to avoid. Black, and one sentence that
 * is true.
 */
function unreachable() {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Madhurita — offline</title>
<style>
  html { color-scheme: dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #000; color: rgba(255, 255, 255, 0.62);
         font: 400 15px/1.6 system-ui, -apple-system, sans-serif; text-align: center }
  p { max-width: 22rem; padding: 0 1.5rem }
</style>
</head><body><p>This device is offline, and she has not been loaded here before.<br />
She is not unreachable — this device is.</p></body></html>`;
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // A mutation is never replayed and never answered from a cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Someone else's server is not this worker's business.
  if (url.origin !== self.location.origin) return;

  // Her state. Read the header — this early return is the whole point of the file.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(shell(request));
    return;
  }

  if (isImmutable(url.pathname)) {
    event.respondWith(immutable(request));
  }
});
