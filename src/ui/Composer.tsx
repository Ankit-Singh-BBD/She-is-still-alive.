/**
 * Where you say something. A textarea that starts as one line.
 *
 * ## Enter sends, Shift+Enter is a newline
 *
 * The convention every messaging interface uses, and the reason a `<textarea>` is
 * here at all rather than an `<input>`: she is talked to in paragraphs sometimes, and
 * a single-line input silently makes that impossible. The height is set from
 * `scrollHeight` after every change, which is the only way to size a textarea to its
 * content without measuring text by hand.
 *
 * ## The text is not cleared until the cycle accepts it
 *
 * `say()` resolves `false` when nothing was sent — rate limited, cognition switched
 * off, session gone. Clearing the box on `false` would destroy what you wrote to
 * learn that she was busy. So it clears on `true` only, and on `false` the words are
 * still there to send again.
 *
 * ## The send control is a dot
 *
 * Not a word, not an arrow. It grows slightly under the pointer and, while a cycle is
 * running, emits a slow expanding ring on roughly the rhythm of the orb's breath — so
 * the two read as one thing working rather than as a spinner attached to a form.
 *
 * ## The microphone arrives as a slot, not as a prop
 *
 * The row is an ear, some words and a mouth, and only the middle two are this file's
 * business. `lead` keeps it that way: the composer knows nothing about sockets,
 * sample rates or whether she can hear at all, and the one place that does — `Presence`
 * — decides whether there is anything to put there.
 */

import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';

export interface ComposerProps {
  /** Resolves `false` when nothing was sent and the text should stay put. */
  say: (text: string) => Promise<boolean>;
  /**
   * This client's own turn is outstanding.
   *
   * Deliberately not "she is thinking": a turn she was spoken must not lock the
   * composer, because typing over her is how you interrupt her, and the cycle gate is
   * built to be interrupted exactly that way.
   */
  thinking: boolean;
  /** What sits at the head of the row, before the words. The microphone, or nothing. */
  lead?: ReactNode;
}

/** Matches `max-height: 9rem` in the stylesheet, at the 16 px root this app uses. */
const MAX_HEIGHT = 144;

export function Composer({ say, thinking, lead }: ComposerProps): ReactElement {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  function resize(): void {
    const element = inputRef.current;
    if (element === null) return;
    // Collapse first: without this the height only ever grows, because
    // `scrollHeight` of an already-tall box is its own height.
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }

  async function send(): Promise<void> {
    if (thinking || text.trim().length === 0) return;
    const sent = await say(text);
    if (!sent) return;
    setText('');
    // The height has to be reset by hand; React clearing the value does not fire
    // the input event that would otherwise drive `resize`.
    const element = inputRef.current;
    if (element !== null) element.style.height = 'auto';
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // `isComposing` is true mid-IME: Enter there is committing a candidate, not
    // sending a message, and intercepting it would break every non-Latin keyboard.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  }

  return (
    <div className="composer">
      {lead}
      <textarea
        className="composer-input"
        ref={inputRef}
        rows={1}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          resize();
        }}
        onKeyDown={onKeyDown}
        placeholder="Say something to her."
        aria-label="Say something to her"
        maxLength={8000}
        autoComplete="off"
        spellCheck
      />
      <button
        className="plain send"
        type="button"
        onClick={() => void send()}
        disabled={thinking || text.trim().length === 0}
        data-thinking={thinking ? 'true' : 'false'}
        aria-label={thinking ? 'She is thinking' : 'Send'}
      >
        <span className="send-dot" />
      </button>
    </div>
  );
}
