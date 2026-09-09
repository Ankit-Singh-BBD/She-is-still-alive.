/**
 * Registering the service worker.
 *
 * Six lines that live in their own module for one reason: `main.tsx` mounts React at
 * import time, so nothing in it can be tested. The decisions here — production only,
 * after `load`, failure ignored — are the ones a test should be able to hold, and
 * `tests/presence/register.test.ts` holds them.
 *
 * What the worker itself does, and the honesty rule it exists to keep, is the header of
 * `public/sw.js`.
 */

/** Where the worker is served from. `public/` is copied to the site root verbatim. */
export const WORKER_URL = '/sw.js';

/**
 * Registers the worker, or declines to for one of two good reasons.
 *
 * ## Production only
 *
 * A service worker in front of the Vite dev server fights it: the dev server rewrites
 * modules on every keystroke and pushes them over its own socket, and a worker holding a
 * cached shell turns a hot-module update into a reload of yesterday's bundle. An
 * installed worker also outlives the dev session on `localhost`, so it would keep
 * answering for that origin afterwards. The worker's whole value — a home-screen icon
 * that opens instantly — is a production value.
 *
 * ## After `load`
 *
 * `install` immediately fetches the shell and two icons. Doing that during the initial
 * load would have it competing with the bundle and the first API call for the same
 * connection, on the one visit where the interface is already slowest. A visit that ends
 * before `load` fires just does not install it, and the next one will.
 *
 * ## A failure is logged and otherwise ignored
 *
 * She works without the worker. It adds an install prompt and an instant shell, not a
 * capability — so a browser that refuses it (a private window, a disabled setting, an
 * insecure origin) should get the app, not an error.
 *
 * There is deliberately no "a new version is available" prompt. The worker calls
 * `skipWaiting()` and `clients.claim()`, and the shell is network-first, so a deploy is
 * picked up on the next navigation with nothing to click.
 */
export function registerServiceWorker(production: boolean): void {
  if (!production) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker.register(WORKER_URL).catch((error: unknown) => {
        console.warn('[madhurita] the service worker did not register:', error);
      });
    },
    { once: true },
  );
}
