// Test doubles for the Durable Object runtime: SQL storage backed by a real in-memory SQLite (node:sqlite), so
// the agent's SQL is exercised as written; key-value storage and alarms in a Map; waitUntil collected so a test
// can await the background work. No network: tests stub `fetch` themselves.
import { DatabaseSync } from "node:sqlite";

type Value = string | number | null | ArrayBuffer;

export interface FakeCtx {
  ctx: DurableObjectState;
  db: DatabaseSync;
  kv: Map<string, unknown>;
  alarms: number[];
  pending: Promise<unknown>[];
  settle: () => Promise<void>;
  failSqlOn?: string;
  failWith?: unknown;
}

export function makeCtx(): FakeCtx {
  const db = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  const alarms: number[] = [];
  const pending: Promise<unknown>[] = [];
  const fake: FakeCtx = {
    db,
    kv,
    alarms,
    pending,
    ctx: undefined as unknown as DurableObjectState,
    settle: async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
  const sql = {
    exec: (query: string, ...params: Value[]) => {
      if (fake.failSqlOn && query.includes(fake.failSqlOn))
        throw "failWith" in fake ? fake.failWith : new Error(`forced failure on ${fake.failSqlOn}`);
      const rows = db.prepare(query).all(...(params as (string | number | null)[])) as Record<string, Value>[];
      return { toArray: () => rows };
    },
  };
  const storage = {
    sql,
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => {
      kv.set(key, value);
    },
    delete: async (key: string) => kv.delete(key),
    setAlarm: async (at: number) => {
      alarms.push(at);
    },
  };
  fake.ctx = {
    storage,
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as unknown as DurableObjectState;
  return fake;
}
