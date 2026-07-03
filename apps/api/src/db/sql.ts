import { eq, getTableColumns } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "./connection.js";
import { databaseTables, type DatabaseTableName } from "./schema.js";

export type SqlValue = string | number | boolean | null;

export function insertRecord(database: AppDatabase, table: string, values: Record<string, SqlValue>): void {
  database.db.insert(getTable(table)).values(values as never).run();
}

export function updateRecord(
  database: AppDatabase,
  table: string,
  values: Record<string, SqlValue>,
  whereColumn: string,
  whereValue: SqlValue
): void {
  if (Object.keys(values).length === 0) {
    throw new Error("updateRecord requires at least one value");
  }

  const tableDefinition = getTable(table);
  const column = getColumn(tableDefinition, whereColumn);
  database.db.update(tableDefinition).set(values as never).where(eq(column, whereValue)).run();
}

function getTable(table: string) {
  const tableDefinition = databaseTables[table as DatabaseTableName];
  if (!tableDefinition) {
    throw new Error(`Unknown database table: ${table}`);
  }

  return tableDefinition;
}

function getColumn(tableDefinition: ReturnType<typeof getTable>, columnName: string): AnySQLiteColumn {
  const columns = getTableColumns(tableDefinition) as Record<string, AnySQLiteColumn>;
  const column = columns[columnName];
  if (!column) {
    throw new Error(`Unknown database column: ${columnName}`);
  }

  return column;
}
