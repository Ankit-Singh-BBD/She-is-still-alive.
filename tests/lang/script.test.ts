/**
 * The one script the whole mind reads.
 *
 * `server/lang/script.ts` exists because of one observed fact: against
 * `gemini-3.1-flash-live-preview`, "main theek hoon Ankit, tum batao kaise ho?" spoken
 * aloud comes back from `inputAudioTranscription` as `मैं ठीक हूं अंकित, तुम बताओ कैसे हो?`
 * — and every part of her downstream reads Roman. The intent vocabulary is Roman
 * regexes, the stored conversation is Roman because she wrote it, and the memory
 * similarity scorer compares tokens against Roman summaries. So the cost of the wrong
 * script is not a garbled string; it is recall that silently degrades to importance and
 * recency for every sentence she is *spoken*, while the same sentence *typed* works.
 *
 * That makes these assertions unusual for a transliteration test. The target is not a
 * standard — not ISO 15919, not IAST, not ITRANS, all of which produce `maiṁ ṭhīka hūṁ`
 * and match nothing the owner has ever typed. The target is the informal Roman Hinglish
 * an Indian keyboard actually produces, so the mapping deliberately throws information
 * away and the tests below pin the *losses* as hard as the mappings: retroflex and
 * dental collapsing to one letter, vowel length collapsing to the short form, and
 * schwas that Devanagari writes and Hindi does not say.
 *
 * Nothing here is reversible and nothing here needs to be. `server/voice/live/session.ts`
 * keeps the provider's own Devanagari and folds on the way out, so what the provider
 * said remains the record of what it said.
 *
 * Its two callers are asserted where they live: `tests/voice/live-session.test.ts` for
 * the ear, `tests/p05/memory.test.ts` for the memory scorer.
 */

import { describe, expect, it } from 'vitest';

// The barrel, for the reason `tests/voice/live-session.test.ts` gives about its own
// imports: a test that reached past it would be the first caller to make it a lie.
import { toRomanHinglish } from '@server/lang/index.js';

describe('the transliterator at the ear', () => {
  it('returns anything without Devanagari in it byte-identical', () => {
    // The fast-path guard, and the reason 958 existing tests did not have to change:
    // a typed turn, an English turn and every fixture in the suite pass through
    // untouched because none of them contain a Devanagari code point.
    for (const text of [
      '',
      'I typed this in Roman',
      'main theek hoon Ankit, tum batao kaise ho?',
      'Haan, 5 baje. Theek hai?',
      '   ',
      'emoji 🙂 and — punctuation',
    ]) {
      expect(toRomanHinglish(text)).toBe(text);
    }
  });

  it('turns the sentence that started this into the script she already writes', () => {
    // Verbatim from the e2e probe: her own voice, at a real microphone, transcribed by
    // the real provider. Everything else in this file is a rule; this is the artifact.
    expect(toRomanHinglish('मैं ठीक हूं अंकित, तुम बताओ कैसे हो?')).toBe(
      'main thik hun ankit, tum batao kaise ho?',
    );
  });

  describe('schwa deletion, which is the difference from a transliteration machine', () => {
    it('drops the word-final schwa Devanagari writes and Hindi does not say', () => {
      expect(toRomanHinglish('ठीक')).toBe('thik');
      expect(toRomanHinglish('तुम')).toBe('tum');
      expect(toRomanHinglish('कर')).toBe('kar');
      expect(toRomanHinglish('बहुत')).toBe('bahut');
      expect(toRomanHinglish('नमस्ते')).toBe('namaste');
      expect(toRomanHinglish('धन्यवाद')).toBe('dhanyavad');
    });

    it('keeps it in a word of one syllable, or न would be "n"', () => {
      expect(toRomanHinglish('न')).toBe('na');
      expect(toRomanHinglish('क')).toBe('ka');
    });

    it('drops a medial schwa in V C ə C V, right to left', () => {
      // लगता is "lagta": the schwa on ग sits between a vowel and a full syllable.
      expect(toRomanHinglish('लगता')).toBe('lagta');
      expect(toRomanHinglish('करता')).toBe('karta');
      expect(toRomanHinglish('समझता')).toBe('samajhta');
      expect(toRomanHinglish('देखता')).toBe('dekhta');
      expect(toRomanHinglish('कमरा')).toBe('kamra');
      // मतलब is where the direction is load-bearing: the schwa on ल survives only
      // *because* the one on ब was deleted first. Left to right this is "matalab".
      expect(toRomanHinglish('मतलब')).toBe('matlab');
    });

    it('never touches the first syllable of a word', () => {
      // Otherwise बताओ is "btao" and गया is "gya" — a word she says constantly.
      expect(toRomanHinglish('बताओ')).toBe('batao');
      expect(toRomanHinglish('गया')).toBe('gaya');
    });

    it('leaves a closed syllable alone, because its vowel is carrying a nasal', () => {
      // The `a` in पसंद is not a deletable schwa; "pasnd" is not a word.
      expect(toRomanHinglish('पसंद')).toBe('pasand');
    });
  });

  describe('the losses, which are the point', () => {
    it('collapses vowel length to the short form', () => {
      // The one genuinely arbitrary choice — ठीक is typed both "thik" and "theek" —
      // and the vowel-length fold in `server/memory/retrieval.ts` is what makes the
      // remaining variance match anyway.
      expect(toRomanHinglish('ठीक')).toBe('thik');
      expect(toRomanHinglish('हूं')).toBe('hun');
      expect(toRomanHinglish('ज़रूरी')).toBe('zaruri');
      expect(toRomanHinglish('याद')).toBe('yad');
    });

    it('collapses retroflex into dental, as every Roman Hinglish reader does', () => {
      // ट and त are both `t`; ड and द are both `d`. A reader supplies the difference.
      expect(toRomanHinglish('ठीक')).toBe('thik');
      expect(toRomanHinglish('तीन')).toBe('tin');
      expect(toRomanHinglish('बड़ा')).toBe('bara');
    });
  });

  describe('the mechanics a wrong answer here would be silent about', () => {
    it('reads a virama as a cluster rather than a vowel', () => {
      expect(toRomanHinglish('क्षमा')).toBe('kshama');
      expect(toRomanHinglish('ज्ञान')).toBe('gyan');
      expect(toRomanHinglish('तुम्हें')).toBe('tumhen');
    });

    it('writes an anusvara as m before a labial and n everywhere else', () => {
      // The difference between "sambhav" and "sanbhav".
      expect(toRomanHinglish('संभव')).toBe('sambhav');
      expect(toRomanHinglish('हैं')).toBe('hain');
      expect(toRomanHinglish('अंकित')).toBe('ankit');
    });

    it('reads a nukta consonant whether the transcriber composed it or not', () => {
      // U+0958-U+095F are composition exclusions: NFC will not produce them, so a
      // transcriber emits consonant + nukta. Both forms have to mean the same letter,
      // and the pair has to be matched before the bare consonant under it — otherwise
      // ज is read and the nukta is left behind as a stray mark.
      //
      // Both forms are written by escape here, because they are visually identical: a
      // test that pasted them as characters would be asserting whatever the editor last
      // normalised the file to, which is how this pair collapsed once already.
      const composed = '\u095B\u0930\u0942\u0930\u0940';
      const decomposed = '\u091C\u093C\u0930\u0942\u0930\u0940';
      expect(decomposed).not.toBe(composed);
      expect(toRomanHinglish(composed)).toBe('zaruri');
      expect(toRomanHinglish(decomposed)).toBe('zaruri');
      expect(toRomanHinglish('\u095E\u094B\u0928')).toBe('fon');
      expect(toRomanHinglish('\u092B\u093C\u094B\u0928')).toBe('fon');
      // And without the nukta it is the letter underneath, not the borrowed sound.
      expect(toRomanHinglish('फोन')).toBe('phon');
    });

    it('carries digits, danda and mixed script through', () => {
      expect(toRomanHinglish('१२३')).toBe('123');
      expect(toRomanHinglish('अच्छा लगता है।')).toBe('achchha lagta hai.');
      // Code-switching mid-sentence is how she is actually spoken to.
      expect(toRomanHinglish('ठीक hai bro')).toBe('thik hai bro');
      expect(toRomanHinglish('कल 5 baje')).toBe('kal 5 baje');
    });
  });
});
