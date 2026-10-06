import pg from 'pg';
import type { Catalogue, ColumnInfo, Policy, TableInfo } from './types.js';

/**
 * Read the policy catalogue. Only pg_* catalogue views are touched.
 * No user table is ever selected from.
 */
export async function readCatalogue(client: pg.Client, schemas: string[]): Promise<Catalogue> {
  const policies = await client.query(
    `select n.nspname as schema, c.relname as "table", p.polname as name,
            case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                          when 'd' then 'DELETE' else 'ALL' end as cmd,
            p.polpermissive as permissive,
            coalesce(array(select r.rolname::text from pg_roles r where r.oid = any (p.polroles) order by 1), '{}') as roles,
            pg_get_expr(p.polqual, p.polrelid) as qual,
            pg_get_expr(p.polwithcheck, p.polrelid) as with_check
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any ($1)
      order by 1, 2, 3`,
    [schemas]
  );
  const tables = await client.query(
    `select n.nspname as schema, c.relname as "table",
            c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any ($1) and c.relkind in ('r', 'p')
      order by 1, 2`,
    [schemas]
  );
  const columns = await client.query(
    `select n.nspname as schema, c.relname as "table", a.attname as "column",
            format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any ($1) and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      order by 1, 2, a.attnum`,
    [schemas]
  );
  return {
    policies: policies.rows.map(
      (r): Policy => ({
        schema: r.schema,
        table: r.table,
        name: r.name,
        cmd: r.cmd,
        permissive: r.permissive,
        roles: r.roles,
        qual: r.qual,
        withCheck: r.with_check
      })
    ),
    tables: tables.rows.map(
      (r): TableInfo => ({ schema: r.schema, table: r.table, rlsEnabled: r.rls_enabled, rlsForced: r.rls_forced })
    ),
    columns: columns.rows.map((r): ColumnInfo => ({ schema: r.schema, table: r.table, column: r.column, type: r.type }))
  };
}
