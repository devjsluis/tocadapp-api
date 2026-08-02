import type { QueryResultRow } from "pg";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => pool.query<T>(text, params);
