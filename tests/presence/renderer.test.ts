/**
 * The renderer's loop, on a fake GPU.
 *
 * `createPresenceRenderer` has had no test coverage at all until now, and could not
 * have: `tests/setup-jsdom.ts` makes `getContext` return `null` for anything but `2d`,
 * which is the right default — it forces every *other* test down the no-WebGL path,
 * the one real visitors on old hardware take. So this file does not use a canvas
 * element. It hands the renderer a plain object with a `getContext` that returns a
 * counting stub, and drives `requestAnimationFrame` by hand.
 *
 * What that buys is the one property of this file that cannot be read off the source:
 * **how many times it draws.** The loop is `requestAnimationFrame`-driven and the
 * shader is five octaves of noise per pixel, several times over, at up to twice the
 * device pixel ratio. When motion is off the frame is a pure function of values that
 * have stopped moving — so a redraw is a full-viewport noise pass that cannot change a
 * pixel, charged to the battery of the person who asked for *less*. Counting
 * `drawArrays` is the only way to know it does not.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AWAITING } from '../../src/visual/mood.js';
import { createPresenceRenderer } from '../../src/visual/renderer.js';

/** Everything `renderer.ts` asks of a `WebGL2RenderingContext`, and nothing else. */
function fakeGl(): { gl: object; counts: { draws: number; viewports: number } } {
  const counts = { draws: 0, viewports: 0 };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    TRIANGLES: 5,
    createShader: (): object => ({}),
    shaderSource: (): void => undefined,
    compileShader: (): void => undefined,
    getShaderParameter: (): boolean => true,
    getShaderInfoLog: (): string => '',
    deleteShader: (): void => undefined,
    createProgram: (): object => ({}),
    attachShader: (): void => undefined,
    detachShader: (): void => undefined,
    linkProgram: (): void => undefined,
    getProgramParameter: (): boolean => true,
    getProgramInfoLog: (): string => '',
    deleteProgram: (): void => undefined,
    getUniformLocation: (_program: unknown, name: string): object => ({ name }),
    createVertexArray: (): object => ({}),
    bindVertexArray: (): void => undefined,
    deleteVertexArray: (): void => undefined,
    useProgram: (): void => undefined,
    viewport: (): void => {
      counts.viewports += 1;
    },
    uniform1f: (): void => undefined,
    uniform2f: (): void => undefined,
    uniform3fv: (): void => undefined,
    drawArrays: (): void => {
      counts.draws += 1;
    },
  };
  return { gl, counts };
}

interface Harness {
  /** Advance the clock and run every callback that was waiting on it. */
  tick: (ms?: number) => void;
  /** Total `drawArrays` calls so far. */
  draws: () => number;
  /** Whether the loop is still scheduled — the thing that watches for a resize. */
  scheduled: () => boolean;
  /** The canvas's backing-store width. Drops when the render scale drops. */
  bufferWidth: () => number;
  resize: (cssWidth: number, cssHeight: number) => void;
}

const REAL_RAF = globalThis.requestAnimationFrame;
const REAL_CANCEL = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = REAL_RAF;
  globalThis.cancelAnimationFrame = REAL_CANCEL;
});

/**
 * A renderer on a fake context and a hand-cranked clock.
 *
 * `requestAnimationFrame` is replaced rather than faked with timers because the loop
 * re-arms itself from inside its own callback: a tick has to run the callbacks that
 * were pending when it started and leave the one they schedule for the next tick.
 */
function harness(): { renderer: NonNullable<ReturnType<typeof createPresenceRenderer>>; h: Harness } {
  const { gl, counts } = fakeGl();
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let now = 0;

  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number): void => {
    pending.delete(id);
  };

  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: (kind: string): object | null => (kind === 'webgl2' ? gl : null),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };

  const renderer = createPresenceRenderer(canvas as unknown as HTMLCanvasElement);
  if (renderer === null) throw new Error('the fake context should have produced a renderer');

  return {
    renderer,
    h: {
      tick: (ms = 16): void => {
        now += ms;
        const due = [...pending.values()];
        pending.clear();
        for (const callback of due) callback(now);
      },
      draws: () => counts.draws,
      scheduled: () => pending.size > 0,
      bufferWidth: () => canvas.width,
      resize: (cssWidth, cssHeight): void => {
        canvas.clientWidth = cssWidth;
        canvas.clientHeight = cssHeight;
      },
    },
  };
}

/** Runs the loop until it stops drawing, or gives up. Returns the frames it took. */
function settle(h: Harness, limit = 600): number {
  for (let i = 0; i < limit; i++) {
    const before = h.draws();
    h.tick();
    if (h.draws() === before) return i;
  }
  throw new Error(`still drawing after ${limit} frames`);
}

describe('createPresenceRenderer', () => {
  it('returns null rather than throwing when the platform has no WebGL2', () => {
    const canvas = {
      getContext: (): null => null,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    };
    // The expected outcome on old hardware and under jsdom, not an error: the caller
    // draws the CSS field instead.
    expect(createPresenceRenderer(canvas as unknown as HTMLCanvasElement)).toBeNull();
  });

  it('draws the first frame without waiting to be told anything', () => {
    const { h } = harness();
    h.tick();
    expect(h.draws()).toBe(1);
  });

  it('draws every frame while motion is on', () => {
    const { h } = harness();
    for (let i = 0; i < 30; i++) h.tick();
    // Time advances, so every frame is a different picture. Nothing to skip.
    expect(h.draws()).toBe(30);
  });
});

describe('createPresenceRenderer — idling with motion off', () => {
  it('stops drawing once the room has stopped moving', () => {
    const { renderer, h } = harness();
    h.tick();
    renderer.setMotion(false);
    const frames = settle(h);
    // `shown` starts at `target`, so nothing has to ease: one frame to show the
    // stilled clock, then silence.
    expect(frames).toBeLessThan(4);
    const drawn = h.draws();
    for (let i = 0; i < 200; i++) h.tick();
    expect(h.draws(), 'a stilled room must not redraw a frame it cannot change').toBe(drawn);
  });

  it('keeps the loop scheduled, because nothing else watches for a resize', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    // `sizeToCanvas` runs inside `draw` and is the only resize mechanism in the
    // client — there is no `resize` listener and no `ResizeObserver`. Stopping the
    // loop would freeze the drawing buffer at a stale size.
    expect(h.scheduled()).toBe(true);
  });

  it('redraws when the window is resized while stilled', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    const drawn = h.draws();
    h.resize(1024, 768);
    h.tick();
    // Resizing a canvas clears its drawing buffer, so this frame is not optional.
    expect(h.draws()).toBe(drawn + 1);
    expect(h.bufferWidth()).toBe(1024);
  });
});

describe('createPresenceRenderer — what wakes a stilled room, and what does not', () => {
  it('wakes for a mood change, and settles again afterwards', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    const drawn = h.draws();

    renderer.setMood({ ...AWAITING, energy: 1, presence: 1 });
    h.tick();
    expect(h.draws(), 'a change she is easing towards has to be shown').toBe(drawn + 1);

    // And it is an ease, not a cut — several seconds of frames, then quiet again.
    const frames = settle(h);
    expect(frames).toBeGreaterThan(30);
  });

  it('does not wake for a mood it is already showing', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    const drawn = h.draws();
    // Compared by value, so the effect that re-sends the same mood on every stream
    // frame cannot defeat the idling.
    renderer.setMood({ ...AWAITING });
    for (let i = 0; i < 10; i++) h.tick();
    expect(h.draws()).toBe(drawn);
  });

  it('does not wake for a pointer move, which it is ignoring anyway', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    const drawn = h.draws();
    renderer.setPointer(1, -1);
    for (let i = 0; i < 10; i++) h.tick();
    // Parallax is motion. Waking to redraw a frame that deliberately ignores the
    // pointer would be the worst of both.
    expect(h.draws()).toBe(drawn);
  });

  it('wakes when motion is switched back on and keeps drawing', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    const drawn = h.draws();
    renderer.setMotion(true);
    for (let i = 0; i < 20; i++) h.tick();
    expect(h.draws()).toBe(drawn + 20);
  });

  it('stops entirely on dispose', () => {
    const { renderer, h } = harness();
    h.tick();
    const drawn = h.draws();
    renderer.dispose();
    h.tick();
    expect(h.draws()).toBe(drawn);
    expect(h.scheduled()).toBe(false);
    // Idempotent: the effect cleanup can run twice under StrictMode.
    expect(() => renderer.dispose()).not.toThrow();
  });
});

describe('createPresenceRenderer — adaptive resolution', () => {
  /** Past `SLOW_FRAME_MS`. A 25 fps cadence, which is comfortably over the budget. */
  const SLOW = 40;

  it('renders at the full backing-store size while frames are cheap', () => {
    const { h } = harness();
    h.tick();
    expect(h.bufferWidth()).toBe(800);
  });

  it('drops the render scale after a sustained run of slow frames', () => {
    const { h } = harness();
    for (let i = 0; i < 60; i++) h.tick(SLOW);
    // The first step of SCALE_STEPS: 800 × 0.72. A weak GPU gets a cheaper frame
    // rather than a stuttering one.
    expect(h.bufferWidth()).toBe(576);
  });

  it('does not drop it for frames it never drew', () => {
    const { renderer, h } = harness();
    renderer.setMotion(false);
    settle(h);
    for (let i = 0; i < 300; i++) h.tick(SLOW);
    // What the budget measures is the interval between callbacks, which on a skipped
    // frame is the display's cadence and says nothing about the GPU. Counting those
    // would let a stilled room quietly degrade itself to half resolution — and the
    // scale never rises again, so it would still be there when motion came back on.
    expect(h.bufferWidth()).toBe(800);
    renderer.setMotion(true);
    for (let i = 0; i < 20; i++) h.tick();
    expect(h.bufferWidth(), 'and it comes back at full resolution').toBe(800);
  });
});
