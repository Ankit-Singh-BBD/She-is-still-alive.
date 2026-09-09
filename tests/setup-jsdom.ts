/**
 * Global test setup.
 *
 * Runs for every test file, including the `environment: 'node'` ones, so it must
 * stay side-effect free unless a browser global is actually present. Each block
 * is guarded: under Node these are all no-ops.
 *
 * Purpose is narrow — give jsdom the handful of APIs the presence layer touches
 * (ResizeObserver, canvas contexts, rAF, matchMedia) so components can mount
 * without pulling in the optional `canvas` native package.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as NodeJS.Timeout);
  };
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * jsdom's `getContext` throws "Not implemented" without the native `canvas`
 * package. The presence layer only needs a 2D context that accepts calls and a
 * WebGL context that reports itself as unavailable, so the renderer takes its
 * documented no-GPU path instead of crashing.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  const noop = (): void => {};
  const make2d = (): Record<string, unknown> => ({
    canvas: null,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop,
    measureText: () => ({ width: 0 }),
    fillText: noop,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
  });

  HTMLCanvasElement.prototype.getContext = function (contextId: string): unknown {
    if (contextId === '2d') return make2d();
    // Report no WebGL/WebGPU in jsdom. Callers must handle this.
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
}
