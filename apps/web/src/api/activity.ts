/**
 * User activity, for the session idle timer. A read sent while nobody has touched the
 * device recently (a refetch after a live hint) is marked as background, so the server
 * does not count it as activity and an unattended device still locks after 5–10 min.
 */
const RECENT_MS = 15_000;
let lastInputAt = Number.NEGATIVE_INFINITY;

export function noteUserActivity(at: number = Date.now()): void {
  lastInputAt = at;
}

export function userRecentlyActive(now: number = Date.now()): boolean {
  return now - lastInputAt <= RECENT_MS;
}

/** Listens for real input (not scrolling by itself, which a running screen never does). */
export function trackUserActivity(target: Pick<Window, 'addEventListener'> = window): void {
  const note = (): void => {
    noteUserActivity();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    target.addEventListener(type, note, { capture: true, passive: true });
  }
}
