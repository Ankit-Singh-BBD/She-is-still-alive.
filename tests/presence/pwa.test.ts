/**
 * The PWA layer: the manifest, the icons, and the one rule the service worker exists to
 * keep.
 *
 * The manifest and the icons are checked for the boring reason — a declared icon that is
 * not on disk, or a `sizes: "512x512"` on a 192-pixel image, is a broken install prompt
 * that nothing else in the toolchain looks at.
 *
 * The service worker is checked for a much less boring one. Caching is the easiest way
 * in this whole codebase to break the honesty contract: a cached `GET /api/state` would
 * bring the room up bright and warm over a conversation from yesterday, with nothing on
 * screen able to tell that it was not now. So this file does not assert that the source
 * *says* it avoids `/api/` — it loads `public/sw.js` into a fake worker scope, dispatches
 * real `Request`s at its `fetch` handler, and asserts that the handler never claims one.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { derivePalette } from '@server/environment/palette.js';

import { paletteVars } from '../../src/lib/palette.js';
import { WORKER_URL } from '../../src/lib/service-worker.js';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

const MANIFEST = JSON.parse(read('public/manifest.webmanifest')) as Manifest;
const HTML = read('index.html');
// Read through the constant the client registers, rather than through a second copy of
// the path: the URL and the file are otherwise two places that have to be renamed
// together, and getting that wrong produces a 404 whose only symptom is an install
// prompt that never appears. This way the rename breaks every test below.
const WORKER = read(`public${WORKER_URL}`);
const GROUND = paletteVars(derivePalette('night', 'unknown'))['--ground']!;

interface Icon {
  src: string;
  type?: string;
  sizes?: string;
  purpose?: string;
}

interface Manifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  background_color?: string;
  theme_color?: string;
  icons?: Icon[];
}

/** The declared pixel size of a PNG, read out of its IHDR rather than out of its name. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(new URL(path, ROOT));
  const signature = bytes.subarray(0, 8).toString('hex');
  expect(signature, `${path} is not a PNG`).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * One pixel out of a PNG, as `#rrggbb`.
 *
 * Enough of a decoder for what `scripts/icons.ts` emits and no more: colour type 2
 * (truecolour, no alpha), bit depth 8, filter 0 on every scanline. It exists so the
 * committed icons can be held to the same palette as everything else — an icon is the
 * one asset that can sit in the repo going quietly out of date, because no gate reads
 * its pixels.
 */
function pngPixel(path: string, x: number, y: number): string {
  const bytes = readFileSync(new URL(path, ROOT));
  const width = bytes.readUInt32BE(16);
  expect(bytes[24], `${path} bit depth`).toBe(8);
  expect(bytes[25], `${path} colour type`).toBe(2);

  const parts: Buffer[] = [];
  let at = 8;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));

  const stride = width * 3 + 1;
  expect(raw[y * stride], `${path} scanline ${y} filter`).toBe(0);
  const pixel = y * stride + 1 + x * 3;
  const hex = (value: number | undefined): string => (value ?? 0).toString(16).padStart(2, '0');
  return `#${hex(raw[pixel])}${hex(raw[pixel + 1])}${hex(raw[pixel + 2])}`;
}

/** Distance between two `#rrggbb` colours, 0..1. Crude on purpose — it only ranks. */
function distance(a: string, b: string): number {
  const channels = (hex: string): number[] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = channels(a) as [number, number, number];
  const [br, bg, bb] = channels(b) as [number, number, number];
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2) / (255 * Math.sqrt(3));
}

describe('public/manifest.webmanifest', () => {
  it('declares what a browser needs before it will offer to install her', () => {
    expect(MANIFEST.name).toBe('Madhurita');
    expect(MANIFEST.start_url).toBe('/');
    expect(MANIFEST.scope).toBe('/');
    expect(MANIFEST.display).toBe('standalone');
    // A stable `id` is what keeps an installed copy pointing at the same app across a
    // change of `start_url` later.
    expect(MANIFEST.id).toBe('/');
  });

  it('paints the splash screen her ground colour, not a guess at it', () => {
    // `background_color` is what the platform fills before the first frame, and
    // `theme_color` is the chrome around it. Both are her night `--ground`, which is
    // also what `index.html` and the stylesheet's `@property` initial values hold, so
    // the launch reads as one surface rather than three that nearly match.
    expect(MANIFEST.background_color).toBe(GROUND);
    expect(MANIFEST.theme_color).toBe(GROUND);

    const meta = /<meta\s+name="theme-color"\s+content="([^"]+)"\s*\/?>/.exec(HTML);
    expect(meta?.[1]).toBe(MANIFEST.theme_color);
  });

  it('offers both a full-bleed and a maskable icon', () => {
    const purposes = (MANIFEST.icons ?? []).map((icon) => icon.purpose);
    // Without a `maskable` entry Android shrinks the `any` icon inside a white plate,
    // which puts a bright square behind her on the home screen.
    expect(purposes).toContain('maskable');
    expect(purposes).toContain('any');
  });

  it('declares the size each icon actually is', () => {
    const icons = MANIFEST.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.src, 'icons are served from /icons/').toMatch(/^\/icons\//);
      if (!icon.src.endsWith('.png')) continue;
      const { width, height } = pngSize(`public${icon.src}`);
      // A `sizes` that disagrees with the file is a broken install prompt and nothing
      // in the build looks at it.
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
      expect(icon.type, icon.src).toBe('image/png');
    }
  });

  it('has a 192 and a 512, the two sizes installability is judged on', () => {
    const sizes = (MANIFEST.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('is within reach of the worker that has to answer for it', () => {
    // A worker's default scope is the directory it is served from, and it can only
    // answer navigations inside that scope. `/sw.js` scopes to `/`, which is exactly
    // what the manifest claims above; from `/assets/sw.js` — where a bundler would
    // naturally put it — the shell fetch this whole file tests would never be seen.
    expect(WORKER_URL.lastIndexOf('/')).toBe(0);
    expect(MANIFEST.scope).toBe('/');
  });
});

/**
 * The committed pixels.
 *
 * `scripts/icons.ts` derives the icon from `derivePalette('night', 'unknown')` so it
 * cannot be a hand-copied palette. But the PNGs it writes are *committed artefacts* —
 * change the palette, forget to re-run `npm run icons`, and the repo now holds an icon
 * in last month's colours that nothing anywhere would notice. These read the pixels
 * back out and rank them against the palette, so the drift is caught rather than
 * shipped.
 *
 * Ranked rather than compared exactly, on purpose: the gaussian constants in the
 * generator are a matter of taste and get tuned. What must not change is *which colour
 * is where*.
 */
describe('public/icons — the committed pixels, still her colours', () => {
  const ACCENT = derivePalette('night', 'unknown').accent;

  it('burns her accent at the centre of the orb', () => {
    // The generator puts the orb's centre at 46% of the height.
    const centre = pngPixel('public/icons/icon-192.png', 96, 88);
    expect(distance(centre, ACCENT), centre).toBeLessThan(distance(centre, GROUND));
    // Not merely nearer — unmistakably lit. A washed-out centre would still pass a
    // nearness test while reading as grey in a task switcher.
    expect(distance(centre, GROUND), centre).toBeGreaterThan(0.4);
  });

  it('holds her ground in the corners, so a launcher crop reveals nothing', () => {
    const corner = pngPixel('public/icons/icon-192.png', 2, 2);
    expect(distance(corner, GROUND), corner).toBeLessThan(0.05);
    expect(distance(corner, ACCENT), corner).toBeGreaterThan(0.4);
  });

  it('renders the two sizes as the same picture, not two drawings', () => {
    // Same composition, same colours — only the sampling rate differs. A mismatch here
    // means one of them was generated from a different palette or a different constant.
    expect(pngPixel('public/icons/icon-512.png', 256, 236)).toBe(
      pngPixel('public/icons/icon-192.png', 96, 88),
    );
  });

  it('pulls the maskable orb inside the circle a launcher may crop to', () => {
    // `purpose: maskable` lets the platform keep only a circle of 80% diameter. At 512
    // that circle's edge is 51 px in from the side, so the same pixel must be dimmer in
    // the maskable variant than in the full-bleed one — that difference *is* the safe
    // area, and it is the only thing distinguishing the two files.
    const safe = pngPixel('public/icons/icon-maskable-512.png', 40, 256);
    const full = pngPixel('public/icons/icon-512.png', 40, 256);
    expect(distance(safe, GROUND), `${safe} vs ${full}`).toBeLessThan(distance(full, GROUND));
  });
});

describe('index.html', () => {
  it('references only icons that exist', () => {
    const referenced = [...HTML.matchAll(/href="(\/icons\/[^"]+)"/g)].map((match) => match[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) {
      expect(() => read(`public${path}`), path).not.toThrow();
    }
  });

  it('links the manifest', () => {
    expect(HTML).toContain('rel="manifest" href="/manifest.webmanifest"');
  });
});

/**
 * A request as the worker reads it.
 *
 * A plain object rather than a real `Request` because the interesting case is
 * `mode: 'navigate'`, and the `Request` constructor is forbidden by spec from producing
 * one. The worker only ever reads `method`, `url` and `mode`, and hands the object
 * straight to `fetch` and to the cache, both of which are stubbed here.
 */
interface FakeRequest {
  method: string;
  url: string;
  mode: string;
}

const req = (url: string, init: { method?: string; mode?: string } = {}): FakeRequest => ({
  method: init.method ?? 'GET',
  url,
  mode: init.mode ?? 'no-cors',
});

const keyOf = (request: FakeRequest | string): string =>
  typeof request === 'string' ? request : new URL(request.url).pathname;

class FakeCache {
  readonly entries = new Map<string, Response>();

  put(request: FakeRequest | string, response: Response): Promise<void> {
    this.entries.set(keyOf(request), response);
    return Promise.resolve();
  }

  match(request: FakeRequest | string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(keyOf(request)));
  }
}

class FakeCacheStorage {
  readonly opened = new Map<string, FakeCache>();

  open(name: string): Promise<FakeCache> {
    const existing = this.opened.get(name);
    if (existing !== undefined) return Promise.resolve(existing);
    const cache = new FakeCache();
    this.opened.set(name, cache);
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.opened.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.opened.delete(name));
  }
}

interface LifecycleEvent {
  waitUntil: (promise: Promise<unknown>) => void;
}

interface FetchEvent {
  request: FakeRequest;
  respondWith: (response: Response | Promise<Response>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
}

type Handler = (event: LifecycleEvent & Partial<FetchEvent>) => void;

interface Harness {
  storage: FakeCacheStorage;
  /** Every URL the worker actually went to the network for, in order. */
  network: string[];
  offline: boolean;
  claims: number;
  skips: number;
  fire: (type: 'install' | 'activate') => Promise<void>;
  /** `undefined` means the worker declined the request and left it to the browser. */
  handle: (request: FakeRequest) => Promise<Response | undefined>;
}

/**
 * Loads `public/sw.js` into a fake `ServiceWorkerGlobalScope`.
 *
 * `new Function` rather than an import because a service worker is not a module and has
 * no exports — its whole contract is the listeners it registers on `self`. Injecting
 * `self` and `fetch` as parameters shadows the real globals, so nothing here can reach
 * the network or a real `CacheStorage`.
 */
function load(): Harness {
  const handlers = new Map<string, Handler[]>();
  const storage = new FakeCacheStorage();
  const harness: Harness = {
    storage,
    network: [],
    offline: false,
    claims: 0,
    skips: 0,
    fire: async (type) => {
      const pending: Promise<unknown>[] = [];
      for (const handler of handlers.get(type) ?? []) {
        handler({ waitUntil: (promise) => void pending.push(promise) });
      }
      await Promise.all(pending);
    },
    handle: async (request) => {
      let answered: Response | Promise<Response> | undefined;
      for (const handler of handlers.get('fetch') ?? []) {
        handler({
          request,
          respondWith: (response) => {
            answered = response;
          },
          waitUntil: () => undefined,
        });
      }
      return answered === undefined ? undefined : await answered;
    },
  };

  const fakeFetch = (input: FakeRequest | string): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input, 'https://madhurita.test').href : input.url;
    harness.network.push(url);
    if (harness.offline) return Promise.reject(new TypeError('offline'));
    return Promise.resolve(new Response(`body:${url}`, { status: 200 }));
  };

  const scope = {
    addEventListener: (type: string, handler: Handler): void => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    location: { origin: 'https://madhurita.test' },
    caches: storage,
    clients: {
      claim: (): Promise<void> => {
        harness.claims += 1;
        return Promise.resolve();
      },
    },
    skipWaiting: (): Promise<void> => {
      harness.skips += 1;
      return Promise.resolve();
    },
  };

  const factory = new Function('self', 'fetch', WORKER) as (
    scope: unknown,
    fetch: typeof fakeFetch,
  ) => void;
  factory(scope, fakeFetch);
  return harness;
}

const ORIGIN = 'https://madhurita.test';

describe('public/sw.js — nothing under /api/ is ever cached or answered from a cache', () => {
  const declined = async (request: FakeRequest): Promise<void> => {
    const worker = load();
    await worker.fire('install');
    worker.network.length = 0;
    const response = await worker.handle(request);
    // Declining means never calling `respondWith`, which leaves the browser's own
    // network path — and, for the stream, its own streaming — completely untouched.
    expect(response, `${request.method} ${request.url} must not be claimed`).toBeUndefined();
    expect(worker.network, 'a declined request must not be fetched by the worker').toEqual([]);
  };

  it('declines the state snapshot', async () => {
    // The one that would break the honesty contract outright: the room would come up
    // bright over a conversation from yesterday with nothing able to say so.
    await declined(req(`${ORIGIN}/api/state`));
  });

  it('declines the event stream', async () => {
    await declined(req(`${ORIGIN}/api/stream`));
  });

  it('declines the transcript and every other read under /api/', async () => {
    await declined(req(`${ORIGIN}/api/conversations/abc/messages?limit=50`));
    await declined(req(`${ORIGIN}/api/hello`));
    await declined(req(`${ORIGIN}/api`));
  });

  it('declines every mutation, inside /api/ and out', async () => {
    await declined(req(`${ORIGIN}/api/chat`, { method: 'POST' }));
    await declined(req(`${ORIGIN}/api/location`, { method: 'POST' }));
    await declined(req(`${ORIGIN}/`, { method: 'POST', mode: 'navigate' }));
    await declined(req(`${ORIGIN}/assets/index-abc123.js`, { method: 'DELETE' }));
  });

  it('declines another origin entirely', async () => {
    await declined(req('https://example.com/assets/index-abc123.js'));
  });

  it('leaves an unrecognised same-origin path to the browser', async () => {
    // Cache-first is only ever correct for something immutable. Anything else — a
    // `/robots.txt`, a future route — goes to the network untouched rather than being
    // guessed at.
    await declined(req(`${ORIGIN}/robots.txt`));
  });
});

describe('public/sw.js — the shell', () => {
  it('precaches the shell on install and takes over immediately', async () => {
    const worker = load();
    await worker.fire('install');
    expect(worker.skips).toBe(1);
    const shell = [...worker.storage.opened.values()][0];
    expect(shell?.entries.has('/')).toBe(true);
    expect(shell?.entries.has('/manifest.webmanifest')).toBe(true);
  });

  it('installs anyway when the network is down', async () => {
    const worker = load();
    worker.offline = true;
    // An install that throws leaves the page with no worker at all, so a failed
    // precache must not be fatal.
    await expect(worker.fire('install')).resolves.toBeUndefined();
    expect(worker.skips).toBe(1);
  });

  it('drops caches from a previous version on activate', async () => {
    const worker = load();
    await worker.storage.open('madhurita-v0-shell');
    await worker.storage.open('madhurita-v0-assets');
    await worker.fire('install');
    await worker.fire('activate');
    expect([...worker.storage.opened.keys()].some((name) => name.includes('v0'))).toBe(false);
    expect(worker.claims).toBe(1);
  });

  it('serves the newest document while the network is up', async () => {
    const worker = load();
    await worker.fire('install');
    worker.network.length = 0;
    const response = await worker.handle(req(`${ORIGIN}/`, { mode: 'navigate' }));
    expect(worker.network).toEqual([`${ORIGIN}/`]);
    expect(await response?.text()).toBe(`body:${ORIGIN}/`);
  });

  it('falls back to the cached document, for any route, when the network fails', async () => {
    const worker = load();
    await worker.fire('install');
    await worker.handle(req(`${ORIGIN}/`, { mode: 'navigate' }));
    worker.offline = true;
    // A deep link offline gets the one shell, because the client is a single page.
    const response = await worker.handle(req(`${ORIGIN}/anything/deep`, { mode: 'navigate' }));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(`body:${ORIGIN}/`);
  });
});

describe('public/sw.js — the last resort', () => {
  it('says something true when the device is offline and has never loaded her', async () => {
    const worker = load();
    worker.offline = true;
    await worker.fire('install');
    const response = await worker.handle(req(`${ORIGIN}/`, { mode: 'navigate' }));
    expect(response?.status).toBe(503);
    const body = (await response?.text()) ?? '';
    // The distinction the sentence has to keep: the device failed, not she.
    expect(body).toContain('This device is offline');
    expect(body).not.toMatch(/she is (offline|unavailable|down)/i);
  });

  it('does not paint the failure in her colours', async () => {
    const worker = load();
    worker.offline = true;
    await worker.fire('install');
    const body = (await (await worker.handle(req(`${ORIGIN}/`, { mode: 'navigate' })))?.text()) ?? '';
    // Her palette means "this is Madhurita, at this hour, under this sky". A page that
    // failed to reach her must not wear it.
    const palette = derivePalette('night', 'unknown');
    for (const colour of [palette.primary, palette.secondary, palette.accent, GROUND]) {
      expect(body.toLowerCase(), colour).not.toContain(colour.toLowerCase());
    }
  });
});

describe('public/sw.js — immutable assets', () => {
  it('fetches a hashed asset once and never again', async () => {
    const worker = load();
    await worker.fire('install');
    worker.network.length = 0;
    const url = `${ORIGIN}/assets/index-abc123.js`;

    const first = await worker.handle(req(url));
    expect(await first?.text()).toBe(`body:${url}`);
    expect(worker.network).toEqual([url]);

    const second = await worker.handle(req(url));
    expect(await second?.text()).toBe(`body:${url}`);
    // Content-hashed bytes cannot change, so a second network trip would be waste.
    expect(worker.network).toEqual([url]);
  });

  it('serves a hashed asset offline once it has been seen', async () => {
    const worker = load();
    await worker.fire('install');
    const url = `${ORIGIN}/assets/index-abc123.css`;
    await worker.handle(req(url));
    worker.offline = true;
    expect(await (await worker.handle(req(url)))?.text()).toBe(`body:${url}`);
  });

  it('caches the icons and the manifest, which have stable paths', async () => {
    const worker = load();
    await worker.fire('install');
    worker.network.length = 0;
    await worker.handle(req(`${ORIGIN}/icons/icon-512.png`));
    expect(worker.network).toEqual([`${ORIGIN}/icons/icon-512.png`]);
    await worker.handle(req(`${ORIGIN}/icons/icon-512.png`));
    expect(worker.network).toHaveLength(1);
  });
});


