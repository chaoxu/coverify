/** A deliberate refusal, as opposed to a bug.
 *
 *  The CLI prints these as a message and drops the stack; anything else keeps
 *  its stack, because that one is a bug report. Marking the intent at the throw
 *  site is the only way to tell them apart — the first attempt classified "an
 *  Error with a nonempty message" as a refusal, which describes nearly every
 *  bug, and a TypeError mid-campaign printed one line with no file and no frame.
 *
 *  Its own module, importing nothing: every layer throws refusals, including
 *  `userdirs.ts`, which sits below `campaign.ts` and cannot import from it. */
export class Refusal extends Error {}
