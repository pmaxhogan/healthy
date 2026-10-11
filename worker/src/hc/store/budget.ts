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

/**
 * What a slice really asked of D1, as D1 and the clock report it: see
 * worker/src/hc/store/counted.ts. Counts and durations only.
 */
export interface Measured {
  /** Calls that left for D1: each `db.batch`, and each statement run alone. */
  roundTrips: number;
  /** Statements in those calls. */
  executed: number;
  /** Wall clock spent waiting on those calls, in ms. */
  d1Ms: number;
  /** SQL time D1 reported for them, in ms: no network in it. */
  sqlMs: number;
  rowsRead: number;
  rowsWritten: number;
}

export class Meter {
  private queries = 0;
  private units = 0;
  private readonly seen: Measured = {
    roundTrips: 0,
    executed: 0,
    d1Ms: 0,
    sqlMs: 0,
    rowsRead: 0,
    rowsWritten: 0,
  };
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

  /** A call to D1 returned (or threw): one round trip of `statements`, `ms` long. */
  trip(statements: number, ms: number): void {
    this.seen.roundTrips += 1;
    this.seen.executed += statements;
    this.seen.d1Ms += ms;
  }

  /** What D1 said of one statement it ran. */
  reported(sqlMs: number, rowsRead: number, rowsWritten: number): void {
    this.seen.sqlMs += sqlMs;
    this.seen.rowsRead += rowsRead;
    this.seen.rowsWritten += rowsWritten;
  }

  /** What has been measured so far, with the durations in whole ms. */
  get measured(): Measured {
    return {
      ...this.seen,
      d1Ms: Math.round(this.seen.d1Ms),
      sqlMs: Math.round(this.seen.sqlMs),
    };
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

  /** The fraction of the statement budget not yet counted: 1 for a fresh meter, 0 once it is spent. */
  get unspent(): number {
    const { maxQueries } = this.budget;
    return maxQueries > 0 ? Math.max(0, 1 - this.queries / maxQueries) : 0;
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

  /**
   * A meter with a budget of its own, on this one's clock, for work that is
   * allowed so much and no more whatever this meter has left. `absorb` it
   * afterwards.
   */
  part(budget: SliceBudget): Meter {
    return new Meter(budget, this.clock);
  }

  /** What this meter may spend in all. */
  get allowed(): SliceBudget {
    return this.budget;
  }

  /** Count what a `share` or a `part` spent and finished as this meter's own. */
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
