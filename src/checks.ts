import type { Db } from './guard.js';
import type { Finding } from './types.js';

/**
 * Catalogue checks. They need no tests and read only pg_* catalogue tables.
 *
 * None of them calls a function it is checking. EXECUTE is tested with
 * has_function_privilege. On some Postgres images a call made without EXECUTE
 * does not raise an error: the backend crashes and every connection restarts.
 */

/** Roles that ship with Supabase and are expected to hold anon or authenticated. */
export const BUILT_IN_MEMBERS = new Set([
  'postgres',
  'supabase_admin',
  'authenticator',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_realtime_admin',
  'supabase_read_only_user',
  'dashboard_user',
  'pgbouncer',
  'service_role'
]);

const CLIENT_ROLES = ['anon', 'authenticated'];

/**
 * 1. A policy calls a function the policy's role cannot EXECUTE.
 *
 * A policy expression runs with the privileges of the role that queries the
 * table, not the policy owner. Without EXECUTE every query by that role on the
 * table fails with "permission denied for function". pg_depend records which
 * functions a policy names; neither grep nor pg_get_functiondef can see that.
 */
export async function checkFunctionExecute(client: Db, schemas: string[]): Promise<Finding[]> {
  const res = await client.query(
    `with deps as (
       select distinct p.oid as pol, n.nspname as tschema, c.relname as tname, p.polname,
              p.polroles, fn.oid as fn_oid, fnn.nspname as fschema, fn.proname,
              pg_get_function_identity_arguments(fn.oid) as fargs
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = p.oid
                         and d.refclassid = 'pg_proc'::regclass
         join pg_proc fn on fn.oid = d.refobjid
         join pg_namespace fnn on fnn.oid = fn.pronamespace
        where n.nspname = any ($1) and fnn.nspname not in ('pg_catalog', 'information_schema')
     )
     select tschema, tname, polname, fschema, proname, fargs, r.rolname::text as role
       from deps
       cross join lateral (
         select rolname from pg_roles
          where case when polroles = '{0}'::oid[] then rolname = any ($2)
                     else oid = any (polroles) end
       ) r
      where not has_function_privilege(r.rolname, fn_oid, 'EXECUTE')
      order by 1, 2, 3, 7`,
    [schemas, CLIENT_ROLES]
  );
  return res.rows.map(
    (r): Finding => ({
      check: 'function-execute',
      severity: 'FAIL',
      title: `policy "${r.polname}" on ${r.tname} calls ${r.proname}(${r.fargs}), but ${r.role} cannot EXECUTE it`,
      detail:
        `Every ${r.role} query on ${r.tname} will fail with "permission denied for function ${r.proname}". ` +
        `Grant EXECUTE on ${r.fschema}.${r.proname}(${r.fargs}) to ${r.role}.`
    })
  );
}

/**
 * 2. A custom role is a member of anon or authenticated.
 *
 * A role that inherits from anon gets every grant and policy anon has. Any
 * restriction placed on the custom role then stops meaning anything.
 */
export async function checkRoleMembership(client: Db): Promise<Finding[]> {
  const res = await client.query(
    `select m.rolname::text as member, g.rolname::text as granted
       from pg_auth_members am
       join pg_roles m on m.oid = am.member
       join pg_roles g on g.oid = am.roleid
      where g.rolname = any ($1)
        and not m.rolsuper
        and coalesce((to_jsonb(am) ->> 'inherit_option')::boolean, m.rolinherit)
      order by 1, 2`,
    [CLIENT_ROLES]
  );
  return res.rows
    .filter((r) => !BUILT_IN_MEMBERS.has(r.member))
    .map(
      (r): Finding => ({
        check: 'role-membership',
        severity: 'FAIL',
        title: `role ${r.member} is a member of ${r.granted}`,
        detail:
          `${r.member} inherits every grant and policy that ${r.granted} has, so any restriction placed on ${r.member} ` +
          `does nothing. Run: REVOKE ${r.granted} FROM ${r.member};`
      })
    );
}

/**
 * 3. A column-level grant sits under a table-level grant.
 *
 * Column privileges are added to table privileges, never subtracted from them.
 * A column-level REVOKE leaves no trace in the catalogue, so it cannot be seen
 * directly. The visible symptom is a role that holds a privilege on the whole
 * table and also has column-level entries for the same privilege: someone
 * restricted by column, and the table-level grant makes it moot.
 */
export async function checkInertColumnGrants(client: Db, schemas: string[]): Promise<Finding[]> {
  const res = await client.query(
    `select n.nspname as schema, c.relname as "table",
            case t.grantee when 0 then 'public' else (select rolname::text from pg_roles where oid = t.grantee) end as role,
            t.privilege_type as priv,
            array_agg(a.attname::text order by a.attnum) as cols
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(c.relacl) t
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attacl is not null
       cross join lateral aclexplode(a.attacl) ca
      where n.nspname = any ($1)
        and c.relkind in ('r', 'p')
        and ca.grantee = t.grantee
        and ca.privilege_type = t.privilege_type
        and t.grantee <> c.relowner
      group by 1, 2, 3, 4
      order by 1, 2, 3, 4`,
    [schemas]
  );
  return res.rows.map(
    (r): Finding => ({
      check: 'inert-column-grant',
      severity: 'FAIL',
      title: `${r.role} has table-level ${r.priv} on ${r.table} and column-level ${r.priv} on (${r.cols.join(', ')})`,
      detail:
        `The table-level grant already covers every column, so column-level grants and REVOKEs on ${r.table} ` +
        `change nothing for ${r.role}. To restrict by column, REVOKE ${r.priv} ON ${r.table} FROM ${r.role} ` +
        `first, then GRANT ${r.priv} on the allowed columns.`
    })
  );
}

/**
 * Words in a function body, with comments and quoted text removed.
 * This is a lexer, not a parser: the body may be PL/pgSQL, which no SQL parser reads.
 * It only needs to answer "does this identifier appear in code, not in a comment or string".
 */
export function codeWords(body: string): string[] {
  const words: string[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    const next = body[i + 1];
    if (ch === '-' && next === '-') {
      while (i < n && body[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (body[i] === '/' && body[i + 1] === '*') (depth++, (i += 2));
        else if (body[i] === '*' && body[i + 1] === '/') (depth--, (i += 2));
        else i++;
      }
    } else if (ch === "'" || ch === '"') {
      i++;
      while (i < n) {
        if (body[i] === ch) {
          if (body[i + 1] === ch) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (ch === '$') {
      // dollar-quoted string: $tag$ ... $tag$
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(body[j])) j++;
      if (body[j] === '$') {
        const tag = body.slice(i, j + 1);
        const close = body.indexOf(tag, j + 1);
        i = close === -1 ? n : close + tag.length;
      } else i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(body[j])) j++;
      words.push(body.slice(i, j).toLowerCase());
      i = j;
    } else i++;
  }
  return words;
}

/** True when the body uses current_user or current_role as code. */
export function usesCurrentUser(body: string): boolean {
  return codeWords(body).some((w) => w === 'current_user' || w === 'current_role');
}

/**
 * 4. current_user inside a SECURITY DEFINER function used for authorisation.
 *
 * Inside SECURITY DEFINER, current_user is the function's owner, never the
 * caller. A check on it always gives the same answer.
 */
export async function checkDefinerCurrentUser(client: Db, schemas: string[]): Promise<Finding[]> {
  const res = await client.query(
    `select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
            p.prosrc as src,
            exists (select 1 from pg_depend d
                     where d.refclassid = 'pg_proc'::regclass and d.refobjid = p.oid
                       and d.classid = 'pg_policy'::regclass) as used_by_policy,
            exists (select 1 from pg_roles r
                     where r.rolname = any ($2) and has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as client_callable
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any ($1) and p.prokind = 'f' and p.prosecdef and p.prosrc is not null
      order by 1, 2`,
    [schemas, CLIENT_ROLES]
  );
  const out: Finding[] = [];
  for (const r of res.rows) {
    if (!usesCurrentUser(r.src)) continue;
    if (!r.used_by_policy && !r.client_callable) continue;
    out.push({
      check: 'definer-current-user',
      severity: r.used_by_policy ? 'FAIL' : 'WARN',
      title: `${r.name}(${r.args}) is SECURITY DEFINER and tests current_user`,
      detail:
        `Inside SECURITY DEFINER, current_user is the function owner, not the caller, so the check always gives the same answer. ` +
        (r.used_by_policy ? 'A policy calls this function. ' : 'Clients can call this function. ') +
        `Use auth.uid() or session_user, or make the function SECURITY INVOKER.`
    });
  }
  return out;
}

export async function runChecks(client: Db, schemas: string[]): Promise<Finding[]> {
  return [
    ...(await checkFunctionExecute(client, schemas)),
    ...(await checkRoleMembership(client)),
    ...(await checkInertColumnGrants(client, schemas)),
    ...(await checkDefinerCurrentUser(client, schemas))
  ];
}
