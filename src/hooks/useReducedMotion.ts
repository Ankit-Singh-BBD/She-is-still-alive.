import { useState, useEffect } from 'react';

export function useReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    
    // Fallback for older browsers that don't support addEventListener on MediaQueryList
    if (mediaQuery.addEventListener) {
      const listener = (event: MediaQueryListEvent) => {
        setReduceMotion(event.matches);
      };
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, []);

  return reduceMotion;
}
