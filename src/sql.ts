/** Quote an identifier. */
export function qi(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Quote a schema-qualified table name. */
export function qt(schema: string, table: string): string {
  return `${qi(schema)}.${qi(table)}`;
}

/** Quote a string literal. */
export function ql(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
