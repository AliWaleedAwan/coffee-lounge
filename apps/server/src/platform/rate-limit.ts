/**
 * In-memory failure throttle (API.md §2, SECURITY.md §2.4). Only failed attempts are
 * counted, so legitimate use (e.g. registering every tablet in one setup session) is
 * never slowed, while guessing codes, passwords or PINs is. One API process serves the
 * shop, so memory is enough; the database lockouts remain the real password defence.
 */
export class FailureThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number, now: () => number = () => Date.now()) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Milliseconds to wait if the key has reached its failure limit, else 0. */
  blockedFor(key: string): number {
    const entry = this.failures.get(key);
    const now = this.now();
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.limit ? entry.resetAt - now : 0;
  }

  recordFailure(key: string): void {
    const now = this.now();
    if (this.failures.size > 10_000) this.prune(now);
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now)
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.failures) if (entry.resetAt <= now) this.failures.delete(key);
  }
}
