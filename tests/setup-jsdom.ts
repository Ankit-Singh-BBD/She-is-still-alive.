/**
 * Global setup for jsdom test environment.
 * Provides polyfills needed for React Three Fiber and other browser APIs.
 */

// Polyfill ResizeObserver for jsdom (required by react-use-measure -> R3F)
if (typeof global.ResizeObserver === 'undefined') {
  class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  global.ResizeObserver = ResizeObserver;
}

// Mock HTMLCanvasElement.getContext for WebGL and 2D in jsdom
// jsdom's default throws "Not implemented" for both '2d' and 'webgl' contexts
// unless the optional 'canvas' npm package is installed. Provide a vi.fn
// shim so React Three Fiber (WebGL) and BackgroundAtmosphere (2D particles)
// can mount in unit tests.
if (typeof HTMLCanvasElement !== 'undefined') {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (contextId: any, options?: any) => any;
  };
  const original = proto.getContext;
  const isJsdomStub = typeof original === 'function' && /\[native code\]/.test(String(original)) === false
    && String(original).includes('not implemented') === false
    ? false : true;

  proto.getContext = function (this: any, contextId: any, options?: any): any {
    if (contextId === '2d') {
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        canvas: this,
      } as unknown as CanvasRenderingContext2D;
    }
    if (
      contextId === 'webgl' ||
      contextId === 'webgl2' ||
      contextId === 'experimental-webgl'
    ) {
      return {
        getExtension: vi.fn(),
        getParameter: vi.fn(() => 0),
        createTexture: vi.fn(),
        bindTexture: vi.fn(),
        texParameteri: vi.fn(),
        texImage2D: vi.fn(),
        clearColor: vi.fn(),
        clearDepth: vi.fn(),
        clear: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        blendFunc: vi.fn(),
        viewport: vi.fn(),
        createShader: vi.fn(),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => true),
        getShaderInfoLog: vi.fn(() => ''),
        createProgram: vi.fn(),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => true),
        getProgramInfoLog: vi.fn(() => ''),
        useProgram: vi.fn(),
        createBuffer: vi.fn(),
        bindBuffer: vi.fn(),
        bufferData: vi.fn(),
        enableVertexAttribArray: vi.fn(),
        vertexAttribPointer: vi.fn(),
        drawArrays: vi.fn(),
        drawElements: vi.fn(),
        getUniformLocation: vi.fn(),
        uniform1f: vi.fn(),
        uniform2f: vi.fn(),
        uniform3f: vi.fn(),
        uniform4f: vi.fn(),
        uniformMatrix4fv: vi.fn(),
        canvas: this,
      } as unknown as WebGLRenderingContext;
    }
    if (typeof original === 'function' && !isJsdomStub) {
      try {
        return original.call(this, contextId, options);
      } catch {
        return null;
      }
    }
    return null;
  } as any;
}
