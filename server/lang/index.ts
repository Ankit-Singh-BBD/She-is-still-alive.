/**
 * Language, as a faculty rather than a subsystem.
 *
 * What lives here is about the words themselves, and it is imported by parts of her
 * that have nothing to do with each other: the ear in `server/voice/live/session.ts`
 * needs it to put one script into the mind, and the memory scorer in
 * `server/memory/retrieval.ts` needs the same rule to compare a stimulus against
 * things she wrote down. It began inside the voice subsystem, where the need was
 * first observed, and moved out the moment the second caller appeared — a memory
 * scorer that imported from `server/voice/` would be describing a dependency she
 * does not have.
 */

export { toRomanHinglish } from './script.js';
