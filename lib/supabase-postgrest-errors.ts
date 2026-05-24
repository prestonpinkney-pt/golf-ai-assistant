/** Heuristics for PostgREST / Supabase JS error messages (schema drift). */

export function postgrestMissingTable(message: string, tableName: string): boolean {
  const m = message.toLowerCase();
  const t = tableName.toLowerCase();
  return (
    (m.includes("could not find the table") && m.includes(t)) ||
    (m.includes("relation") && m.includes(t) && m.includes("does not exist"))
  );
}

export function postgrestMissingColumn(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("column") && m.includes("does not exist");
}

/** True when PostgREST reports a missing `business_id` column (filter or select). */
export function postgrestMissingBusinessIdColumn(message: string): boolean {
  return postgrestMissingColumn(message) && message.toLowerCase().includes("business_id");
}
