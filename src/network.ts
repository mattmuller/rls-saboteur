import type { Db } from './guard.js';

/**
 * Switch off outbound HTTP inside a copy (never the source). A copy inherits the pg_net and http extensions and
 * whatever triggers, Supabase database webhooks and functions call them. A trigger runs as its owner and cannot be
 * stopped with a REVOKE, so the functions themselves are replaced: every function in schema "net" and every function
 * that belongs to the pg_net or http extension keeps its name, arguments and return type, and does nothing.
 * Triggers and webhook helpers (supabase_functions.http_request) then call a function that does nothing.
 */
const LIST_SQL = `
  select format('create or replace function %I.%I(%s) returns %s language plpgsql as %L',
                n.nspname, p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid),
                case when p.proretset or p.prorettype = 'void'::regtype
                          or coalesce(p.proargmodes && array['o','b','t']::"char"[], false)
                     then 'begin return; end' else 'begin return null; end' end) as ddl,
         n.nspname || '.' || p.proname as fname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prokind = 'f'
     and (n.nspname = 'net'
          or exists (select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'
                        and e.extname in ('pg_net', 'http')))
   order by 2`;

const OTHER_SQL = `select extname from pg_extension where extname in ('dblink', 'postgres_fdw', 'plpython3u', 'plperlu', 'pltclu', 'file_fdw') order by 1`;

export interface IsolateResult {
  replaced: string[];
  /** Things that can still reach outside and were not switched off. */
  remaining: string[];
}

/** Runs on the master template. Throws when a function could not be replaced: the copy would not be safe. */
export async function isolateNetwork(copy: Db): Promise<IsolateResult> {
  const list = await copy.query(LIST_SQL);
  const failed: string[] = [];
  const replaced: string[] = [];
  for (const row of list.rows as { ddl: string; fname: string }[]) {
    try {
      await copy.query(row.ddl);
      replaced.push(row.fname);
    } catch (e) {
      failed.push(`${row.fname} (${(e as Error).message})`);
    }
  }
  if (failed.length) {
    throw new Error(
      `Could not switch off outbound HTTP in the copy: ${failed.join('; ')}. ` +
        `Pass --admin-url with a superuser URL so the copy can be changed, or --no-isolate-network to accept the risk.`
    );
  }
  const other = await copy.query(OTHER_SQL);
  const remaining = (other.rows as { extname: string }[]).map((r) => r.extname);
  return { replaced, remaining };
}
