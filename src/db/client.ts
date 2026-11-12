import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing. Set it in .env or repository secrets.");
  }
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export type AppDb = ReturnType<typeof createDb>;

