/**
 * @proxypulse/service-crunchyroll — service compatibility adapter (checker, rules, scorer).
 *
 * Plugging in another service means implementing the same three pieces: a `Checker` that issues one
 * polite probe through a proxy, `rules` that map a response onto passed/failed/blocked, and a
 * `scorer` that turns the verdict into a quality factor. The pipeline only depends on `check()`.
 */

export * from './types.js';
export * from './rules.js';
export * from './scorer.js';
export { CrunchyrollChecker, type CheckerStats } from './checker.js';
