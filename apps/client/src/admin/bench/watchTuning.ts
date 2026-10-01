import { applyTunables, type TunableValues } from '@rune/shared';

/**
 * The Watch panel's numbers. Its studio stages run on the page's own copy of the config, so the
 * chosen set is applied while it is open and the code defaults put back when it closes: nothing
 * else on the admin page reads those numbers (the bench measures in its worker).
 */
export function watchWith(values: Readonly<TunableValues>): void {
  applyTunables(values);
}

export function endWatch(): void {
  applyTunables({});
}
