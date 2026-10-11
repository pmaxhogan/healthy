/**
 * What one slice of the ingest runner may spend.
 *
 * Two limits, and both are hard platform ones seen from a safe distance. D1
 * allows about a thousand queries per Worker invocation, and every statement
 * of a `db.batch` counts as one; an invocation that reaches the limit dies
 * mid-way with nothing to catch. So the work counts its own statements and
 * stops well short. Wall clock is the other: a slice that yields early costs
 * one more alarm, a slice that is cut off costs a retry.
 *
 * A slice always does at least one unit of work, whatever the budget says
 * (`mayStart`). Otherwise a unit that costs more than the whole budget would
 * be put off for ever.
 */

export interface SliceBudget {
  /** Statements, counted by the code that issues them. */
  maxQueries: number;
  maxMs: number;
}

/**
 * The runner's budget. 650 of D1's ~1000 queries leaves room for the one unit
 * that was already under way when the count was last checked; 20 seconds is
 * what the full-refresh runner asks of an alarm, for the same reason.
 */
export const DEFAULT_SLICE_BUDGET: SliceBudget = { maxQueries: 650, maxMs: 20_000 };

export class Meter {
  private queries = 0;
  private units = 0;
  private readonly startedAt: number;

  constructor(
    private readonly budget: SliceBudget,
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = clock();
  }

  /** Count statements about to be issued. */
  spend(queries = 1): void {
    this.queries += queries;
  }

  /** Record that one unit of work finished: the slice has made progress. */
  done(): void {
    this.units += 1;
  }

  get progressed(): boolean {
    return this.units > 0;
  }

  /** Statements counted so far. */
  get statements(): number {
    return this.queries;
  }

  /** Units of work finished so far. */
  get unitsDone(): number {
    return this.units;
  }

  /** Which budget is spent, if either: what a slice that stopped early stopped on. */
  get spent(): "statements" | "time" | null {
    if (this.elapsedMs >= this.budget.maxMs) return "time";
    return this.queries >= this.budget.maxQueries ? "statements" : null;
  }

  /**
   * A meter for a bounded share of what this one may spend, for work that must
   * not be allowed to crowd out the rest of the slice. `absorb` it afterwards.
   */
  share(fraction: number): Meter {
    return new Meter(
      {
        maxQueries: Math.floor(this.budget.maxQueries * fraction),
        maxMs: Math.floor(this.budget.maxMs * fraction),
      },
      this.clock,
    );
  }

  /** Count what a `share` spent and finished as this meter's own. */
  absorb(part: Meter): void {
    this.queries += part.queries;
    this.units += part.units;
  }

  get elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /**
   * Whether a unit expected to cost about `queries` statements may begin. The
   * first unit of a slice always may.
   */
  mayStart(queries: number): boolean {
    if (this.units === 0) return true;
    const affordable = this.queries + queries <= this.budget.maxQueries;
    return affordable && this.elapsedMs < this.budget.maxMs;
  }
}
