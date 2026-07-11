import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AppConfig } from "../config.js";
import { restrictPrivateFile } from "../domain/permissions.js";
import { migrate } from "./migrate.js";
import { schema } from "./schema.js";

export interface AppDatabase {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

export function createDatabase(config: AppConfig): AppDatabase {
  const sqlite = new Database(config.databasePath);
  migrate(sqlite);
  restrictPrivateFile(config.databasePath);
  restrictPrivateFile(`${config.databasePath}-shm`);
  restrictPrivateFile(`${config.databasePath}-wal`);
  const db = drizzle(sqlite, { schema });

  return { sqlite, db };
}
