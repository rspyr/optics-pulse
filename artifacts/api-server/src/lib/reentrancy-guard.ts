/**
 * Re-entrancy guard for periodic background sweeps.
 *
 * Many schedulers fire a sweep on a fixed `setInterval`, but a single sweep can
 * outlast its own interval (lots of rows to process, a slow DB). Without a
 * guard, every tick launches another overlapping sweep and the redundant runs
 * pile up, wasting DB work and connections. This helper wraps a sweep so at
 * most one runs at a time: a tick that fires while the previous run is still in
 * progress is dropped (the next tick picks up whatever remains).
 *
 * The guard lives at the *scheduling* layer, not inside the sweep itself, so
 * direct/concurrent callers (e.g. tests, manual triggers) are unaffected and
 * any correctness guarantees inside the sweep still hold.
 *
 * Each call to `createGuardedRunner` owns its own private in-progress flag, so
 * independent schedulers (or multiple timers within one scheduler) never block
 * each other — only repeated ticks of the *same* runner are coalesced.
 *
 * @param label        Log prefix used when a tick is skipped (e.g. "SyncScheduler:jobs").
 * @param defaultSweep Optional sweep used when the returned runner is invoked
 *                     with no argument. Callers may still pass an explicit sweep
 *                     (handy for unit tests).
 * @returns A runner that resolves to `true` if the sweep ran, or `false` if it
 *          was skipped because a previous run was still in progress. The flag is
 *          always cleared in `finally`, so a thrown sweep does not permanently
 *          block future ticks (the rejection still propagates to the caller).
 */
export function createGuardedRunner(
  label: string,
  defaultSweep?: () => Promise<void>,
): (sweep?: () => Promise<void>) => Promise<boolean> {
  let inProgress = false;

  return async (sweep = defaultSweep): Promise<boolean> => {
    if (!sweep) {
      throw new Error(
        `[${label}] No sweep provided and no default sweep configured`,
      );
    }
    if (inProgress) {
      console.log(`[${label}] Previous sweep still running; skipping this tick`);
      return false;
    }
    inProgress = true;
    try {
      await sweep();
    } finally {
      inProgress = false;
    }
    return true;
  };
}
