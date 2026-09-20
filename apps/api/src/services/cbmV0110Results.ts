/** Translate CBM's compact tables into MemoRepo's stable result objects. */
export function normalizeCbmV0110Result(tool: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (tool === "search_graph" || tool === "search_code") {
    if (isRecord(value.semantic)) {
      const { semantic, groups, ...metadata } = value;
      return { ...metadata, results: expandTable(semantic) };
    }
    const { cols, rows, groups, qn_rule, ...metadata } = value;
    if (!Array.isArray(cols)) return value;
    return {
      ...metadata,
      results: expandTable(value),
      ...(isRecord(value.raw_matches) ? { raw_matches: expandTable(value.raw_matches) } : {})
    };
  }
  if (tool === "trace_path") {
    return {
      ...value,
      ...(isRecord(value.callers) ? { callers: expandTable(value.callers) } : {}),
      ...(isRecord(value.callees) ? { callees: expandTable(value.callees) } : {})
    };
  }
  if (tool === "query_graph" && Array.isArray(value.cols)) {
    const { cols, ...rest } = value;
    return { ...rest, columns: cols };
  }
  return value;
}

function expandTable(table: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(table.cols) || !table.cols.every((column) => typeof column === "string")) {
    throw new Error("CBM returned an invalid table schema");
  }
  const columns = table.cols as string[];
  const decode = (rows: unknown, group: Record<string, unknown> = {}): Record<string, unknown>[] => {
    if (!Array.isArray(rows)) throw new Error("CBM returned invalid table rows");
    return rows.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error("CBM returned an invalid table row");
      const item = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
      if (typeof group.file === "string") item.file = group.file;
      if (typeof group.qn_prefix === "string" && typeof item.name === "string") {
        item.qn = group.qn_prefix ? `${group.qn_prefix}.${item.name}` : item.name;
      }
      if (typeof item.qn === "string") {
        item.qualified_name = item.qn;
        item.name ??= item.qn.split(".").at(-1);
        delete item.qn;
      }
      if (typeof item.file === "string") { item.file_path = item.file; delete item.file; }
      if (typeof item.lines === "string" && /^\d+(?:-\d+)?$/u.test(item.lines)) {
        const [start, end] = item.lines.split("-").map(Number);
        item.start_line = start;
        item.end_line = end ?? start;
        delete item.lines;
      }
      return item;
    });
  };
  if (Array.isArray(table.rows)) return decode(table.rows);
  if (Array.isArray(table.groups)) return table.groups.flatMap((group) => {
    if (!isRecord(group)) throw new Error("CBM returned an invalid table group");
    return decode(group.rows, group);
  });
  throw new Error("CBM returned a table without rows or groups");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
