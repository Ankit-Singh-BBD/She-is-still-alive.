// @vitest-environment jsdom

/**
 * When she asks the browser to install her, and when she deliberately does not.
 *
 * The registration is four lines and three of them are refusals, which is exactly why it
 * needs a test: every one of those refusals is invisible when it works and silent when it
 * breaks. A worker registered in development quietly serves yesterday's bundle over the
 * dev server's own socket. A registration fired before `load` competes with the bundle on
 * the slowest visit there is. A registration that throws takes the whole entry module
 * down and she never mounts at all — to install a cache.
 *
 * `src/main.tsx` cannot be imported by a test: it mounts React at import time. So the
 * decision it makes (`import.meta.env.PROD`) is passed *in* to
 * `src/lib/service-worker.ts`, and this file drives that function directly against a
 * fake `navigator.serviceWorker`.
 *
 * Nothing here touches the filesystem, and it could not: jsdom replaces the global `URL`
 * with one that resolves a relative path against the document's `http://localhost:3000/`
 * rather than against the `import.meta.url` it is handed, so `new URL('../../x',
 * import.meta.url)` — the idiom the rest of `tests/presence/` reads files with — silently
 * produces an http URL here. That `WORKER_URL` names a file that is actually committed is
 * therefore asserted in `pwa.test.ts`, which runs in node.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORKER_URL, registerServiceWorker } from '../../src/lib/service-worker.js';

/** A `ServiceWorkerContainer` with the one method the registration calls. */
function fakeContainer(outcome: 'resolves' | 'rejects' = 'resolves'): {
  container: ServiceWorkerContainer;
  urls: string[];
} {
  const urls: string[] = [];
  const container = {
    register: (url: string): Promise<ServiceWorkerRegistration> => {
      urls.push(url);
      return outcome === 'resolves'
        ? Promise.resolve({} as ServiceWorkerRegistration)
        : Promise.reject(new Error('registration failed'));
    },
  };
  return { container: container as unknown as ServiceWorkerContainer, urls };
}

/** Installs the fake onto jsdom's `navigator`, which has no `serviceWorker` of its own. */
function withContainer(container: ServiceWorkerContainer): void {
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
}

/** Fires `load` the way the browser would once the page has finished settling. */
function load(): void {
  window.dispatchEvent(new Event('load'));
}

/** Lets the `.catch()` on the registration promise run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  // Deleted rather than set to undefined: the `'serviceWorker' in navigator` guard is a
  // presence test, and a property holding `undefined` would still pass it.
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.restoreAllMocks();
});

describe('registerServiceWorker', () => {
  it('registers the worker from the site root', async () => {
    const { container, urls } = fakeContainer();
    withContainer(container);
    registerServiceWorker(true);
    load();
    await flush();
    expect(urls).toEqual([WORKER_URL]);
  });

  it('waits for load rather than registering during it', async () => {
    const { container, urls } = fakeContainer();
    withContainer(container);
    registerServiceWorker(true);
    await flush();
    // `install` fetches the shell and two icons the moment it registers. Doing that
    // while the bundle and the first API call are still in flight makes the slowest
    // visit slower — the one visit where it is least affordable.
    expect(urls, 'nothing may be fetched before the page has finished loading').toEqual([]);
    load();
    await flush();
    expect(urls).toEqual([WORKER_URL]);
  });

  it('does not register in development, even where the browser would allow it', async () => {
    const { container, urls } = fakeContainer();
    withContainer(container);
    registerServiceWorker(false);
    load();
    await flush();
    // A worker in front of the Vite dev server turns a hot-module update into a reload
    // of a cached bundle, and outlives the dev session on `localhost` afterwards.
    expect(urls).toEqual([]);
  });

  it('does nothing at all where the browser has no service workers', () => {
    // jsdom is that browser, and so is any private window with the feature off. There is
    // no fake installed here on purpose.
    expect('serviceWorker' in navigator).toBe(false);
    expect(() => {
      registerServiceWorker(true);
      load();
    }).not.toThrow();
  });

  it('registers once, however many times load fires', async () => {
    const { container, urls } = fakeContainer();
    withContainer(container);
    registerServiceWorker(true);
    load();
    load();
    await flush();
    // Registering twice is harmless — the browser dedupes by scope — but the listener
    // that would do it is a leak on the document, and `{ once: true }` is the whole
    // reason it is not one.
    expect(urls).toEqual([WORKER_URL]);
  });

  it('lets a refusal go, because she works without it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { container, urls } = fakeContainer('rejects');
    withContainer(container);
    registerServiceWorker(true);
    load();
    await flush();
    expect(urls).toEqual([WORKER_URL]);
    // Not swallowed silently — an insecure origin or a disabled setting is worth one
    // line in the console. But not rethrown either: the worker adds an install prompt
    // and an instant shell, not a capability, and an unhandled rejection here would be
    // a failure to load *her* in order to fail to load a cache.
    expect(warn).toHaveBeenCalledOnce();
  });
});
