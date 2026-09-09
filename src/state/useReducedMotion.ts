/**
 * `prefers-reduced-motion`, watched rather than sampled.
 *
 * Sampling it once at mount would be enough for almost every visit and wrong for
 * the one that matters: someone who turns the setting on *because* the field is
 * making them ill should see it stop, not have to reload the page to be believed.
 *
 * The stylesheet honours the same query for its own transitions, so this hook
 * exists only for the canvas, which CSS cannot reach.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** `true` when the field may animate. Defaults to allowing motion. */
export function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return !window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(QUERY);
    const onChange = (): void => setAllowed(!list.matches);
    onChange();
    // `addEventListener` on a MediaQueryList is the modern form; the jsdom stub in
    // `tests/setup-jsdom.ts` provides both it and the deprecated `addListener`.
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  return allowed;
}
