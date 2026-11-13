// D1 on node:sqlite, for the Worker's unit tests: prepare / bind / first /
// run / all, and batch as one transaction. `failNextBatch` makes the next
// batch fail: "before" it is applied, or "after" (applied, but the answer is
// lost, as when the connection drops).
import { DatabaseSync } from "node:sqlite";

export const fakeD1 = () => {
  const db = new DatabaseSync(":memory:");
  let failNext: "before" | "after" | null = null;
  const statement = (sql: string, values: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (db.prepare(sql).get(...(values as any[])) as any) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(values as any[])).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...(values as any[])) }),
    exec: () => db.prepare(sql).all(...(values as any[])),
  });
  return {
    sqlite: db,
    failNextBatch: (when: "before" | "after") => {
      failNext = when;
    },
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      const when = failNext;
      failNext = null;
      if (when === "before") {
        throw new Error("D1 not reachable");
      }
      db.exec("BEGIN");
      try {
        const results = statements.map((item) => item.exec());
        db.exec("COMMIT");
        if (when === "after") {
          throw new Error("D1's answer was lost");
        }
        return results;
      } catch (error) {
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
        throw error;
      }
    },
  };
};
