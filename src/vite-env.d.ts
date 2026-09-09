/**
 * Vite's client-side ambient types.
 *
 * `tsconfig.json` pins `types` to `["node", "vitest/globals", "@testing-library/jest-dom"]`,
 * which switches off automatic `@types` discovery — so nothing pulls `vite/client` in on
 * its own. Without it `import './styles.css'` in `main.tsx` has no declaration and
 * `tsc` fails, which fails `npm run build` outright (`build` is `tsc && vite build`).
 *
 * This file is in the program because `tsconfig.json` includes `src/**\/*.ts`, and a
 * `.d.ts` matches that.
 */

/// <reference types="vite/client" />
