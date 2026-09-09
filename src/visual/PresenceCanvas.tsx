/**
 * The room she is in: a full-viewport canvas, or a field of CSS gradients when
 * the platform has no WebGL2.
 *
 * ## The fallback is a real design, not an apology
 *
 * `createPresenceRenderer` returns `null` under jsdom and on hardware without
 * WebGL2, and the answer is not a blank screen or an error card — it is the same
 * composition drawn with two radial gradients and a linear one, from the same
 * custom properties the shader reads. It has no motion and no grain, so it bands a
 * little on a cheap panel, and it is otherwise the same room.
 *
 * ## Why the pointer listener is passive and on `window`
 *
 * Parallax has to keep working while the pointer is over the composer, the
 * transcript, or anything else that will ever sit on top of the canvas — so the
 * listener cannot be on the canvas itself. It is `passive` because it never
 * prevents default, and it does no work beyond storing two numbers: the easing
 * that turns them into movement happens inside the render loop, so a fast mouse
 * cannot generate more work than there are frames.
 */

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import type { Mood } from './mood.js';
import { createPresenceRenderer, type PresenceRenderer } from './renderer.js';

export interface PresenceCanvasProps {
  mood: Mood;
  /** `false` freezes the field. Set from `prefers-reduced-motion`. */
  motion: boolean;
}

export function PresenceCanvas({ mood, motion }: PresenceCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PresenceRenderer | null>(null);
  /**
   * The mood is kept in a ref as well as a prop because the renderer is built in
   * an effect that must not re-run when the mood changes — rebuilding a WebGL
   * context sixty times a second is not a thing to leave to a dependency array.
   */
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const renderer = createPresenceRenderer(canvas);
    rendererRef.current = renderer;
    if (renderer === null) {
      // No WebGL2. The CSS field below is already painted; nothing to drive.
      canvas.dataset['state'] = 'unavailable';
      return;
    }
    canvas.dataset['state'] = 'live';
    renderer.setMood(moodRef.current);
    renderer.setMotion(motion);

    const onPointer = (event: PointerEvent): void => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      renderer.setPointer((event.clientX / w) * 2 - 1, (event.clientY / h) * 2 - 1);
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    return () => {
      window.removeEventListener('pointermove', onPointer);
      renderer.dispose();
      rendererRef.current = null;
    };
    // `motion` is applied through its own effect below; including it here would
    // tear down and rebuild the GL context every time the media query flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.setMood(mood);
  }, [mood]);

  useEffect(() => {
    rendererRef.current?.setMotion(motion);
  }, [motion]);

  return (
    <div className="field" aria-hidden="true">
      <div className="field-css" />
      <canvas className="field-gl" ref={canvasRef} />
    </div>
  );
}
