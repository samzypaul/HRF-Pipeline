import { Pool, type QueryResultRow } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
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
      max: Number(process.env.DB_POOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      ssl: isLocal || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: true },
    });
  }
  return globalForDb.__hfrPool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!globalForDb.__hfrDb) {
    globalForDb.__hfrDb = drizzle(getPool(), { schema });
  }
  return globalForDb.__hfrDb;
}

/** Run a raw drizzle `sql` query and return typed rows. */
export async function q<T extends QueryResultRow = Record<string, unknown>>(query: SQL): Promise<T[]> {
  const res = await getDb().execute(query);
  return res.rows as T[];
}

export async function closeDb() {
  if (globalForDb.__hfrPool) {
    await globalForDb.__hfrPool.end();
    globalForDb.__hfrPool = undefined;
    globalForDb.__hfrDb = undefined;
  }
}

export { schema };
