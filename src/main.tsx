/**
 * The entry point: four document-level jobs, then React.
 *
 * Everything about *her* lives under `ui/`, `state/` and `visual/`. What is left here is
 * the handful of things that belong to the page rather than to any component, and that
 * would be wrong to do inside an effect.
 *
 * ## 1. The stylesheet
 *
 * Imported, not linked, so Vite hashes it and inlines the critical `@property`
 * registrations into the built HTML's head. Those registrations are what make the
 * palette *transition* instead of cutting — an unregistered custom property is a
 * discrete value and cannot interpolate.
 *
 * ## 2. The visual viewport
 *
 * See the `#root` rule in `styles.css`. The short version: on iOS the on-screen keyboard
 * shrinks only the visual viewport, and no CSS length tracks that, so the composer would
 * end up underneath the keys. Measuring it here is the only way, and it has to be written
 * before the first paint rather than from an effect, or the room would visibly resize
 * once on load.
 *
 * ## 3. The service worker
 *
 * Registered here rather than from a component, because it belongs to the document and
 * must not be torn down and re-registered when React remounts. Only the *decision* —
 * whether this is a built app — is made here; the registration itself is
 * `src/lib/service-worker.ts`, which is where its three rules are written down and the
 * only reason it is a separate module is that this file cannot be imported by a test
 * without mounting React. What the worker does and does not cache, and why nothing under
 * `/api/` is ever cached, is the whole header of `public/sw.js`.
 *
 * ## 4. A missing root is reported, not swallowed
 *
 * `index.html` ships `<div id="root">`, so a null here means the HTML and this file have
 * come apart — a broken deploy, not a runtime condition. There is no interface to
 * apologise *in*, so it goes to the console and the page stays on the CSS field, which is
 * at least the right room with nothing in it.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

import { registerServiceWorker } from './lib/service-worker.js';
import { App } from './ui/App.js';

/**
 * Keeps `--viewport` on `<html>` equal to the height actually available to the page.
 *
 * `visualViewport.height` excludes the keyboard, the URL bar and any other browser
 * furniture, which is exactly what the room wants. It is rounded down: a fractional
 * height on a fractional device pixel ratio leaves a sub-pixel seam of `--ground` under
 * the composer, and one pixel of extra scroll costs nothing.
 *
 * No cleanup, deliberately — this listener lives as long as the document does, and
 * `visualViewport` is a permanent singleton, not a resource.
 */
function trackViewport(): void {
  const viewport = window.visualViewport;
  if (viewport === null || viewport === undefined) return;

  const write = (): void => {
    document.documentElement.style.setProperty('--viewport', `${Math.floor(viewport.height)}px`);
  };

  write();
  // `resize` covers the keyboard and the rotating device; `scroll` covers iOS pushing
  // the layout viewport up under the keyboard, which changes nothing about the height
  // but is the moment the browser has finished settling on one.
  viewport.addEventListener('resize', write);
  viewport.addEventListener('scroll', write);
}

trackViewport();

/**
 * Registers `public/sw.js`, in a built app only.
 *
 * `import.meta.env.PROD` is a compile-time constant, so in a development bundle this
 * whole call is a dead branch that Vite removes — the reason the flag is read here and
 * passed in, rather than read inside the module where it would be untestable.
 */
registerServiceWorker(import.meta.env.PROD);

const root = document.getElementById('root');
if (root === null) {
  console.error('[madhurita] no #root in the document — the page cannot be mounted.');
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
