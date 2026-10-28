import { Pool, type QueryResultRow } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { env } from "../env";

/**
 * One small connection pool per server instance.
 * Works with Neon (use the *pooled* connection string, sslmode=require)
 * and with a local Postgres + PostGIS for development.
 */
const globalForDb = globalThis as unknown as { __hfrPool?: Pool; __hfrDb?: NodePgDatabase<typeof schema> };

export function getPool(): Pool {
  if (!globalForDb.__hfrPool) {
    const url = env.databaseUrl;
    const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
    globalForDb.__hfrPool = new Pool({
      connectionString: url,
      max: env.dbPoolMax,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000, // Neon can take a few seconds to wake up
      keepAlive: true, // stops proxies and NAT from silently dropping idle connections
      keepAliveInitialDelayMillis: 10_000,
      ssl: isLocal || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: true },
    });
    // A dropped idle connection must not crash the process; the pool opens a new one on the next query.
    globalForDb.__hfrPool.on("error", (e) => console.error("[db] idle connection error", e.message));
  }
  return globalForDb.__hfrPool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!globalForDb.__hfrDb) {
    globalForDb.__hfrDb = drizzle(getPool(), { schema });
  }
  return globalForDb.__hfrDb;
}

const dialect = new PgDialect();
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|Connection terminated|timeout exceeded when trying to connect|57P01/i;

/** Neon answers every query with SQLSTATE 53000 once the project is over its plan limits; retrying cannot help until the plan changes. */
export function isQuotaError(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  return cause?.code === "53000" || (e as { code?: string })?.code === "53000" || /exceeded the quota/i.test((e as Error)?.message ?? "");
}

/** drizzle reports only "Failed query: ..."; put the driver's reason (ECONNRESET, timeout, syntax error...) in the message. */
function explain(e: unknown): unknown {
  const cause = (e as { cause?: Error })?.cause;
  if (!(e instanceof Error) || !cause?.message || e.message.includes(cause.message)) return e;
  const firstLine = e.message.split(/\r?\n/)[0];
  return new Error(`${firstLine} (${cause.message})`, { cause });
}

/** Run a raw drizzle `sql` query and return typed rows. Read-only queries are retried up to 3 times on a dropped connection. */
export async function q<T extends QueryResultRow = Record<string, unknown>>(query: SQL): Promise<T[]> {
  const db = getDb();
  try {
    return (await db.execute(query)).rows as T[];
  } catch (e) {
    const detail = [(e as Error)?.message, ((e as { cause?: Error }).cause)?.message].join(" ");
    const readOnly = /^\s*(select|with)\b/i.test(dialect.sqlToQuery(query).sql);
    if (!readOnly || !TRANSIENT.test(detail)) throw explain(e);
    // Neon drops idle connections and can take a few seconds to wake, so one quick retry is not always enough.
    for (let attempt = 1; ; attempt++) {
      console.warn(`[db] connection problem, retry ${attempt}/3:`, detail.trim());
      await new Promise((r) => setTimeout(r, 500 * attempt));
      try {
        return (await db.execute(query)).rows as T[];
      } catch (e2) {
        const d2 = [(e2 as Error)?.message, ((e2 as { cause?: Error }).cause)?.message].join(" ");
        if (attempt >= 3 || !TRANSIENT.test(d2)) throw explain(e2);
      }
    }
  }
}

export async function closeDb() {
  if (globalForDb.__hfrPool) {
    await globalForDb.__hfrPool.end();
    globalForDb.__hfrPool = undefined;
    globalForDb.__hfrDb = undefined;
  }
}

export { schema };
