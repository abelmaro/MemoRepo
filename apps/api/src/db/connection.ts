import Database from "better-sqlite3";
import fs from "node:fs";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AppConfig } from "../config.js";
import { restrictPrivateFile } from "../domain/permissions.js";
import { CURRENT_SCHEMA_VERSION, migrate } from "./migrate.js";
import { schema } from "./schema.js";

export interface AppDatabase {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

export function createDatabase(config: AppConfig): AppDatabase {
  const sqlite = new Database(config.databasePath);
  try {
    backupBeforeSchemaUpgrade(sqlite, config.databasePath);
    migrate(sqlite);
    restrictPrivateFile(config.databasePath);
    restrictPrivateFile(`${config.databasePath}-shm`);
    restrictPrivateFile(`${config.databasePath}-wal`);
    const db = drizzle(sqlite, { schema });
    return { sqlite, db };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function backupBeforeSchemaUpgrade(sqlite: Database.Database, databasePath: string): string | null {
  if (databasePath === ":memory:" || !fs.existsSync(databasePath)) return null;
  const version = sqlite.pragma("user_version", { simple: true }) as number;
  const hasExistingSchema = version > 0 || (sqlite.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).get() as { count: number }).count > 0;
  if (!Number.isSafeInteger(version) || !hasExistingSchema || version >= CURRENT_SCHEMA_VERSION) return null;
  const backupPath = `${databasePath}.pre-v${CURRENT_SCHEMA_VERSION}.sqlite`;
  if (!fs.existsSync(backupPath)) {
    sqlite.prepare("VACUUM INTO ?").run(backupPath);
    restrictPrivateFile(backupPath);
  }
  return backupPath;
}
