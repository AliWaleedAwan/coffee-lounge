/**
 * Seeded randomness for property tests (TEST_PLAN.md PT-xx). Every run prints nothing
 * unless it fails; a failure names its seed, and CL_PROP_SEED=<seed> replays it exactly.
 * CL_PROP_RUNS sets how many sequences a property tries (longer runs before phase exits).
 */
export function propRuns(fallback: number): number {
  const n = Number(process.env['CL_PROP_RUNS']);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Seeds for this run: the fixed one from CL_PROP_SEED, or `runs` fresh ones. */
export function propSeeds(runs: number): number[] {
  const fixed = Number(process.env['CL_PROP_SEED']);
  if (Number.isInteger(fixed) && fixed > 0) return [fixed];
  return Array.from({ length: runs }, () => 1 + Math.floor(Math.random() * 2 ** 31));
}

export class Random {
  readonly seed: number;
  private state: number;

  constructor(seed: number) {
    this.seed = seed;
    this.state = seed >>> 0;
  }

  /** mulberry32: small, fast, and good enough to drive tests. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Decimal string in [min, max] with `places` decimals. */
  decimal(min: number, max: number, places: number): string {
    const scale = 10 ** places;
    return (this.int(Math.round(min * scale), Math.round(max * scale)) / scale).toFixed(places);
  }
}

/** Runs `property` once per seed; a failure is rethrown naming the seed to replay. */
export async function forEachSeed(
  runs: number,
  property: (random: Random) => Promise<void> | void,
): Promise<void> {
  for (const seed of propSeeds(runs)) {
    try {
      await property(new Random(seed));
    } catch (error) {
      throw new Error(`property failed; replay with CL_PROP_SEED=${String(seed)}`, {
        cause: error,
      });
    }
  }
}
