import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AppConfig } from "../config.js";
import { migrate } from "./migrate.js";
import { schema } from "./schema.js";

export interface AppDatabase {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

export function createDatabase(config: AppConfig): AppDatabase {
  const sqlite = new Database(config.databasePath);
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });

  return { sqlite, db };
}
