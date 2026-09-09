/**
 * The deterministic floor under stage 6.
 *
 * `server/cognition/stages/6.ts` takes an `IntentRecognizer` in the slot the
 * language faculty occupies when there is one, and `server/app.ts` builds it over
 * the tool registry's own ids. See `recognizer.ts` for what it will and will not
 * read out of a sentence, and `time.ts` for the rule it never breaks: no time is
 * ever invented.
 */

export { createIntentRecognizer, stimulusText, readStatedPreference, type IntentRecognizer } from './recognizer.js';
export { parseWhen, type WhenReading, type AbsoluteWhen, type DayOnlyWhen } from './time.js';
