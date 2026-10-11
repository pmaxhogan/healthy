/**
 * D1, counted: what a slice of the ingest runner really asked of the database.
 *
 * The runner's budget is an estimate kept by the code that issues statements
 * (worker/src/hc/store/budget.ts). This is the measurement beside it: every
 * call that leaves the runner for D1 -- a `db.batch`, or one statement run by
 * itself -- is one round trip, and D1 says of each statement how long its SQL
 * took and how many rows it read and wrote. Together with the slice's wall
 * clock that tells the three costs of a slice apart: the network (round trips),
 * the database (SQL time, rows), and this code's own work.
 *
 * It wraps the binding and changes nothing about what is sent: the same
 * statements, in the same calls, in the same order. Only the two members the
 * store uses are wrapped (`prepare`, `batch`); the rest pass straight through.
 *
 * Numbers only. Nothing of a statement's text, its parameters or its rows is
 * kept.
 */

import type { Meter } from "./budget.ts";

/** What D1 reports of one statement that this module adds up. */
interface Reported {
  meta?: { duration?: unknown; rows_read?: unknown; rows_written?: unknown };
}

const numberOr0 = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Run one call to D1, and tell the meter what it was and what came back. */
async function counted<T>(meter: Meter, statements: number, call: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const out = await call();
    const results = (Array.isArray(out) ? out : [out]) as Reported[];
    for (const result of results) {
      const meta = (result as Reported | null)?.meta;
      if (meta === undefined) continue;
      meter.reported(
        numberOr0(meta.duration),
        numberOr0(meta.rows_read),
        numberOr0(meta.rows_written),
      );
    }
    return out;
  } finally {
    // A call that threw was a round trip all the same.
    meter.trip(statements, Date.now() - startedAt);
  }
}

/**
 * A prepared statement that counts itself when it is run alone. `inner` is the
 * real one, which is what a `db.batch` has to be given.
 */
class CountedStatement {
  private readonly meter: Meter;
  readonly inner: D1PreparedStatement;

  constructor(inner: D1PreparedStatement, meter: Meter) {
    this.inner = inner;
    this.meter = meter;
  }

  bind(...values: unknown[]): CountedStatement {
    return new CountedStatement(this.inner.bind(...values), this.meter);
  }

  first(...column: [] | [string]): Promise<unknown> {
    const [name] = column;
    // `first` returns a row, or a value of it: there is no `meta` to report.
    return counted(this.meter, 1, () =>
      name === undefined ? this.inner.first() : this.inner.first(name),
    );
  }

  run(): Promise<unknown> {
    return counted(this.meter, 1, () => this.inner.run());
  }

  all(): Promise<unknown> {
    return counted(this.meter, 1, () => this.inner.all());
  }

  raw(options?: { columnNames?: boolean }): Promise<unknown> {
    return counted(this.meter, 1, () =>
      options?.columnNames === true
        ? this.inner.raw({ columnNames: true })
        : this.inner.raw({ columnNames: false }),
    );
  }
}

/** The real statement behind one this module handed out, or the statement itself. */
function innerOf(statement: unknown): D1PreparedStatement {
  return statement instanceof CountedStatement
    ? statement.inner
    : (statement as D1PreparedStatement);
}

/** `db`, with every round trip made through it reported to `meter`. */
export function countedDb(db: D1Database, meter: Meter): D1Database {
  const wrapped = {
    prepare: (query: string) => new CountedStatement(db.prepare(query), meter),
    batch: (statements: unknown[]) =>
      counted(meter, statements.length, () =>
        db.batch(statements.map((statement) => innerOf(statement))),
      ),
    exec: (query: string) => db.exec(query),
    withSession: (...constraint: Parameters<D1Database["withSession"]>) =>
      db.withSession(...constraint),
  };
  // Structurally the part of a D1 binding this codebase calls. D1's own classes
  // are abstract and cannot be extended from here, so the cast is the seam.
  return wrapped as unknown as D1Database;
}
