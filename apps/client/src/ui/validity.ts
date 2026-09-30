import type { FormEvent } from 'react';

/**
 * The rule a patterned field breaks, said in the browser's own validation bubble. A `title` would
 * do the same but also shows as a hover tooltip, which the game UI does without.
 */
export function patternHint(message: string): { onInvalid: (e: FormEvent<HTMLInputElement>) => void; onInput: (e: FormEvent<HTMLInputElement>) => void } {
  return {
    onInvalid: (e) => e.currentTarget.setCustomValidity(e.currentTarget.validity.patternMismatch ? message : ''),
    // A custom message keeps the field invalid until cleared, so every edit clears it and the
    // pattern is checked afresh.
    onInput: (e) => e.currentTarget.setCustomValidity(''),
  };
}
