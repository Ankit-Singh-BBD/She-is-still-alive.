/**
 * The WebGL2 renderer behind the presence layer. No `three`, no scene graph.
 *
 * ## What it owns
 *
 * One program, one full-screen triangle, ten uniforms, and a `requestAnimationFrame`
 * loop. It knows nothing about React, cognition or the API — it takes a `Mood` and
 * eases towards it. Everything that could make a frame expensive (allocating,
 * rebuilding state, re-resolving uniforms) happens once at construction.
 *
 * ## Three things that are easy to get wrong and are handled here
 *
 * **No context is not a crash.** `getContext('webgl2')` returns `null` under jsdom
 * and on hardware that has no WebGL2, so `createPresenceRenderer` returns `null`
 * and the caller draws the CSS field instead. That is the path the test setup in
 * `tests/setup-jsdom.ts` deliberately forces.
 *
 * **Context loss is normal.** A GPU reset, a laptop waking, a driver update — the
 * browser fires `webglcontextlost` and every object this file holds becomes
 * invalid. Without `preventDefault()` the context never comes back at all, so the
 * page would keep running with a permanently black canvas and no error.
 *
 * **Mood changes must ease.** Sunset does not arrive as a cut. Every scalar and
 * colour is approached exponentially per frame, so a palette change, a cycle
 * starting, or a stream dropping all read as the room shifting rather than as a
 * repaint.
 *
 * ## Adaptive resolution
 *
 * The shader is fill-rate bound: it is five octaves of noise per pixel, several
 * times over. On a weak GPU at a 3× device pixel ratio that is not affordable, so
 * the render scale drops after a sustained run of slow frames. It never rises
 * again — oscillating between two resolutions is more visible than sitting at the
 * lower one.
 */

import type { Mood } from './mood.js';
import { FRAGMENT_SOURCE, UNIFORM_NAMES, VERTEX_SOURCE, type UniformName } from './shaders/presence.js';

/** Device pixel ratio is capped here: past 2 the shader costs more than it shows. */
const MAX_PIXEL_RATIO = 2;

/** Frame budget in ms. Sustained frames slower than this drop the render scale. */
const SLOW_FRAME_MS = 24;
const SLOW_FRAME_RUN = 45;
const SCALE_STEPS = [1, 0.72, 0.5] as const;

/** Where the frozen frame sits when motion is off. Chosen for a pleasant composition. */
const STILL_TIME = 11.5;

export interface PresenceRenderer {
  /** The target mood. Approached over the next few frames, never applied at once. */
  setMood: (mood: Mood) => void;
  /** Pointer parallax, in -1..1. Ignored when motion is off. */
  setPointer: (x: number, y: number) => void;
  /** `false` freezes time at a fixed frame. Honours `prefers-reduced-motion`. */
  setMotion: (enabled: boolean) => void;
  /** Releases the loop, the listeners and the GPU objects. Idempotent. */
  dispose: () => void;
}

interface Uniforms {
  location: Record<UniformName, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    // Logged rather than thrown: a shader that will not compile should degrade to
    // the CSS field, not take the whole interface down with it.
    console.warn('[presence] shader failed to compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  if (vertex === null || fragment === null) {
    if (vertex !== null) gl.deleteShader(vertex);
    if (fragment !== null) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (program === null) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The shaders are detached and deleted whether or not the link succeeded; the
  // program keeps its own reference until it is deleted itself.
  gl.detachShader(program, vertex);
  gl.detachShader(program, fragment);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    console.warn('[presence] program failed to link:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function resolve(gl: WebGL2RenderingContext, program: WebGLProgram): Uniforms {
  const location = {} as Record<UniformName, WebGLUniformLocation | null>;
  for (const name of UNIFORM_NAMES) location[name] = gl.getUniformLocation(program, name);
  return { location };
}

/** Exponential approach, framerate-independent. `rate` is the fraction closed per second. */
function ease(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * Builds a renderer on `canvas`, or returns `null` when the platform has no
 * WebGL2. A `null` return is an expected outcome, not an error.
 */
export function createPresenceRenderer(canvas: HTMLCanvasElement): PresenceRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // The field is redrawn every frame, so there is nothing to preserve — and
    // saying so lets the driver skip a full-screen copy per frame.
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (gl === null) return null;

  let program = link(gl);
  if (program === null) return null;
  let uniforms = resolve(gl, program);

  // A VAO is required by the spec even with no attributes; without one bound,
  // `drawArrays` is an INVALID_OPERATION in a core WebGL2 context.
  let vao = gl.createVertexArray();

  const target: Mood = {
    primary: [0.05, 0.05, 0.09],
    secondary: [0.1, 0.1, 0.17],
    accent: [0.56, 0.43, 0.88],
    dayness: 0,
    turbulence: 0.14,
    energy: 0,
    presence: 0.34,
  };
  /**
   * What is actually on screen this frame, eased towards `target`.
   *
   * Colours are held as mutable triples rather than as the `Mood`'s readonly
   * tuples because they are written per channel per frame, and `uniform3fv` wants
   * an array it can read directly — building a new one sixty times a second is the
   * one allocation this loop would otherwise make. They start *at* the target so
   * the first frame is the room, not a fade up from black.
   */
  const shown = {
    primary: [...target.primary] as [number, number, number],
    secondary: [...target.secondary] as [number, number, number],
    accent: [...target.accent] as [number, number, number],
    dayness: target.dayness,
    turbulence: target.turbulence,
    energy: target.energy,
    presence: target.presence,
  };

  let pointerTarget: [number, number] = [0, 0];
  const pointer: [number, number] = [0, 0];

  let motion = true;
  let time = STILL_TIME;
  let last = 0;
  let frame = 0;
  let disposed = false;
  let scaleIndex = 0;
  let slowRun = 0;
  let width = 0;
  let height = 0;

  function sizeToCanvas(): void {
    const scale = SCALE_STEPS[scaleIndex] ?? 1;
    const ratio = Math.min(
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1,
      MAX_PIXEL_RATIO,
    );
    // `clientWidth`/`clientHeight` rather than `getBoundingClientRect()`: this runs
    // every frame, and the rect would force a fresh layout each time for a value
    // that only changes on resize. The canvas is `position: fixed; inset: 0`, so
    // rounding to whole CSS pixels loses nothing.
    const cssWidth = canvas.clientWidth || 1;
    const cssHeight = canvas.clientHeight || 1;
    const w = Math.max(1, Math.round(cssWidth * ratio * scale));
    const h = Math.max(1, Math.round(cssHeight * ratio * scale));
    if (w === width && h === height) return;
    width = w;
    height = h;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }

  function draw(now: number): void {
    if (disposed) return;
    frame = requestAnimationFrame(draw);

    const dt = last === 0 ? 1 / 60 : Math.min((now - last) / 1000, 1 / 12);
    const frameMs = last === 0 ? 0 : now - last;
    last = now;

    if (frameMs > SLOW_FRAME_MS) {
      slowRun += 1;
      if (slowRun >= SLOW_FRAME_RUN && scaleIndex < SCALE_STEPS.length - 1) {
        scaleIndex += 1;
        slowRun = 0;
        width = 0; // force `sizeToCanvas` to reallocate at the new scale
      }
    } else if (slowRun > 0) {
      slowRun -= 1;
    }

    sizeToCanvas();
    if (motion) time += dt;

    // Colour eases slower than the scalars: a palette shift should be almost
    // subliminal, while a cycle starting should be felt within a beat.
    for (let i = 0; i < 3; i++) {
      shown.primary[i] = ease(shown.primary[i]!, target.primary[i]!, 0.5, dt);
      shown.secondary[i] = ease(shown.secondary[i]!, target.secondary[i]!, 0.5, dt);
      shown.accent[i] = ease(shown.accent[i]!, target.accent[i]!, 0.5, dt);
    }
    shown.dayness = ease(shown.dayness, target.dayness, 0.5, dt);
    shown.turbulence = ease(shown.turbulence, target.turbulence, 0.8, dt);
    shown.energy = ease(shown.energy, target.energy, 2.6, dt);
    shown.presence = ease(shown.presence, target.presence, 1.6, dt);
    pointer[0] = ease(pointer[0], motion ? pointerTarget[0] : 0, 3.5, dt);
    pointer[1] = ease(pointer[1], motion ? pointerTarget[1] : 0, 3.5, dt);

    if (program === null || vao === null) return;
    gl.useProgram(program);
    gl.bindVertexArray(vao);

    const at = uniforms.location;
    if (at.uRes) gl.uniform2f(at.uRes, width, height);
    if (at.uTime) gl.uniform1f(at.uTime, motion ? time : STILL_TIME);
    if (at.uPrimary) gl.uniform3fv(at.uPrimary, shown.primary);
    if (at.uSecondary) gl.uniform3fv(at.uSecondary, shown.secondary);
    if (at.uAccent) gl.uniform3fv(at.uAccent, shown.accent);
    if (at.uDayness) gl.uniform1f(at.uDayness, shown.dayness);
    if (at.uTurbulence) gl.uniform1f(at.uTurbulence, shown.turbulence);
    if (at.uEnergy) gl.uniform1f(at.uEnergy, shown.energy);
    if (at.uPresence) gl.uniform1f(at.uPresence, shown.presence);
    if (at.uPointer) gl.uniform2f(at.uPointer, pointer[0], pointer[1]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * The context is gone and every handle above is invalid. `preventDefault()` is
   * what allows a `webglcontextrestored` to follow at all — without it the canvas
   * stays black for the life of the page with nothing reported.
   */
  function onLost(event: Event): void {
    event.preventDefault();
    cancelAnimationFrame(frame);
    frame = 0;
    program = null;
    vao = null;
  }

  function onRestored(): void {
    if (disposed) return;
    program = link(gl);
    if (program === null) return;
    uniforms = resolve(gl, program);
    vao = gl.createVertexArray();
    width = 0;
    height = 0;
    last = 0;
    frame = requestAnimationFrame(draw);
  }

  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  frame = requestAnimationFrame(draw);

  return {
    setMood: (mood: Mood): void => {
      target.primary = mood.primary;
      target.secondary = mood.secondary;
      target.accent = mood.accent;
      target.dayness = mood.dayness;
      target.turbulence = mood.turbulence;
      target.energy = mood.energy;
      target.presence = mood.presence;
    },
    setPointer: (x: number, y: number): void => {
      pointerTarget = [x, y];
    },
    setMotion: (enabled: boolean): void => {
      motion = enabled;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (vao !== null) gl.deleteVertexArray(vao);
      if (program !== null) gl.deleteProgram(program);
      // Asking for the context to be released matters on a page that mounts and
      // unmounts: browsers cap live WebGL contexts and silently drop the oldest.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
