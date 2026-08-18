/**
 * Shared shape for every state machine in the domain (epic E2).
 *
 * A transition either succeeds with the next state or refuses with a
 * machine-readable reason. Refusal is a value, not an exception: an
 * illegal transition is a normal business outcome (the UI disables a
 * button, the sync layer returns a rejection), not a crash.
 */
export type TransitionResult<S extends string> =
  | { ok: true; next: S }
  | { ok: false; reason: string };

export function allow<S extends string>(next: S): TransitionResult<S> {
  return { ok: true, next };
}

export function refuse<S extends string>(reason: string): TransitionResult<S> {
  return { ok: false, reason };
}
