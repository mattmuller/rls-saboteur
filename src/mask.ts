import { randomBytes } from 'node:crypto';
import type { Db } from './guard.js';
import { qi } from './sql.js';

/**
 * Masking. Chosen columns are rewritten in the first copy (the master template) BEFORE the baseline or any break runs,
 * so every later copy inherits masked values. It fails closed: a column that does not exist, a type that cannot be
 * masked, an SQL error, a row that was not touched or a value that survived all stop the run. The run never goes on
 * with the rows it was told to scramble.
 */

export type MaskStrategy = 'scramble' | 'null';

export interface MaskSpec {
  schema: string;
  table: string;
  column: string;
  strategy: MaskStrategy;
}

export const maskText = (m: MaskSpec): string => `${m.schema}.${m.table}.${m.column}${m.strategy === 'null' ? '=null' : ''}`;

/** Reads `schema.table.column[=scramble|null]`. Parts may be "double quoted". Anything else is an error. */
export function parseMask(raw: string): MaskSpec {
  const bad = (why: string): never => {
    throw new Error(`--mask "${raw}": ${why}. Write schema.table.column or schema.table.column=null.`);
  };
  let rest = raw.trim();
  let strategy: MaskStrategy = 'scramble';
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const m = /^(?:"((?:[^"]|"")+)"|([^."=\s]+))/.exec(rest);
    if (!m) return bad('expected a schema, table and column name');
    parts.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
    rest = rest.slice(m[0].length);
    if (i < 2) {
      if (!rest.startsWith('.')) return bad('expected schema.table.column');
      rest = rest.slice(1);
    }
  }
  if (rest.startsWith('=')) {
    const s = rest.slice(1).trim();
    if (s !== 'scramble' && s !== 'null') return bad(`the strategy must be scramble or null, got "${s}"`);
    strategy = s;
    rest = '';
  }
  if (rest.trim() !== '') return bad('unexpected text after the column name');
  return { schema: parts[0], table: parts[1], column: parts[2], strategy };
}

interface ColumnFacts {
  relkind: string;
  type: string;
  base: string;
  generated: string;
  identity: string;
  maxLen: number | null;
}

const COLUMN_SQL = `select c.relkind::text as relkind, format_type(a.atttypid, a.atttypmod) as type, t.typname::text as base,
       a.attgenerated::text as generated, a.attidentity::text as identity,
       case when t.typname in ('varchar', 'bpchar') and a.atttypmod > 4 then a.atttypmod - 4 else null end as maxlen
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
 where n.nspname = $1 and c.relname = $2 and a.attname = $3 and a.attnum > 0 and not a.attisdropped`;

const TEXTLIKE = new Set(['text', 'varchar', 'bpchar', 'citext', 'name']);
const INTS: Record<string, number> = { int2: 32767, int4: 2147483647, int8: 2147483647 };

async function factsOf(db: Db, m: MaskSpec): Promise<ColumnFacts | string> {
  const r = await db.query(COLUMN_SQL, [m.schema, m.table, m.column]);
  if (r.rows.length === 0) return `${m.schema}.${m.table}.${m.column} does not exist`;
  const row = r.rows[0];
  const f: ColumnFacts = {
    relkind: row.relkind,
    type: row.type,
    base: row.base,
    generated: row.generated,
    identity: row.identity,
    maxLen: row.maxlen === null ? null : Number(row.maxlen)
  };
  if (f.relkind !== 'r' && f.relkind !== 'p') return `${m.schema}.${m.table} is not a table`;
  if (f.generated !== '') return `${m.schema}.${m.table}.${m.column} is a generated column and cannot be rewritten`;
  return f;
}

/** Problems with the named columns, read from a database with plain selects. Empty means every column can be masked. */
export async function validateMasks(db: Db, masks: MaskSpec[]): Promise<string[]> {
  const problems: string[] = [];
  for (const m of masks) {
    const f = await factsOf(db, m);
    if (typeof f === 'string') {
      problems.push(f);
      continue;
    }
    const why = unsupported(m, f);
    if (why) problems.push(why);
    const up = (await parentsProblem(db, m)) ?? (await treeProblem(db, m));
    if (up) problems.push(up);
  }
  if (!problems.length) problems.push(...(await linkProblems(db, masks)));
  return problems;
}

/**
 * A table with a parent cannot be masked on its own: the parent's statistics (pg_stats with inherited = true) also hold the
 * child's values, and the parent is not rewritten. Mask the root instead, whose rewrite reaches every table below it.
 */
async function parentsProblem(db: Db, m: MaskSpec): Promise<string | null> {
  const r = await db.query(PARENTS_SQL, [m.schema, m.table]);
  const parents = (r.rows as { parent: string }[]).map((x) => x.parent);
  return parents.length
    ? `${m.schema}.${m.table} inherits from ${parents.join(', ')}, whose statistics also hold its values. Mask ${m.column} on ${parents.join(' or ')} instead (that reaches this table too)`
    : null;
}

function unsupported(m: MaskSpec, f: ColumnFacts): string | null {
  if (m.strategy === 'null') return null;
  if (TEXTLIKE.has(f.base) || f.base === 'uuid' || f.base in INTS) return null;
  return `${m.schema}.${m.table}.${m.column} has type ${f.type}, which scramble does not handle. Use ${m.schema}.${m.table}.${m.column}=null`;
}

/** The expression that replaces a value. Deterministic for one run (same input, same output), different on every run. */
export function scrambleExpr(col: string, f: Pick<ColumnFacts, 'base' | 'type' | 'maxLen'>, salt: string): string {
  const lit = `'${salt}'`;
  const h = `md5(${lit} || ${col}::text)`;
  if (TEXTLIKE.has(f.base)) return `left(${h}, ${f.maxLen ?? 32})::${f.type}`;
  if (f.base === 'uuid') return `${h}::uuid`;
  if (f.base in INTS) {
    const top = INTS[f.base];
    return `((hashtextextended(${lit} || ${col}::text, 0) & 9223372036854775807) % ${top})::${f.type}`;
  }
  throw new Error(`no scramble for type ${f.type}`);
}

/** Counts original values (from the session table _sab_mask) still held in the statistics of a column. Zero is the only pass. */
export const STATS_SQL = `select (
    (select count(*) from pg_stats s,
            unnest(coalesce(s.most_common_vals::text::text[], '{}') || coalesce(s.histogram_bounds::text::text[], '{}')) u(v)
      where s.schemaname = $1 and s.tablename = $2 and s.attname = $3 and u.v in (select v::text from _sab_mask))
  + (select count(*) from pg_stats_ext s, unnest(s.most_common_vals) u(v)
      where s.schemaname = $1 and s.tablename = $2 and $3 = any (s.attnames) and u.v in (select v::text from _sab_mask))
  + (select count(*) from pg_stats_ext_exprs s,
            unnest(coalesce(s.most_common_vals::text::text[], '{}') || coalesce(s.histogram_bounds::text::text[], '{}')) u(v)
      where s.schemaname = $1 and s.tablename = $2 and u.v in (select v::text from _sab_mask))
  )::int as n`;

/**
 * The table and every table below it: legacy inheritance children and declarative partitions, at any depth.
 * An UPDATE through the parent rewrites rows in all of them, so each one needs its own VACUUM and statistics check.
 */
export const TREE_SQL = `with recursive t as (
    select c.oid, n.nspname::text as schema, c.relname::text as name, c.relkind::text as kind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2
    union
    select c.oid, n.nspname::text, c.relname::text, c.relkind::text
      from pg_inherits i join t on i.inhparent = t.oid
      join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace)
  select schema, name, kind from t order by (oid = (select oid from t limit 1)) desc, schema, name`;

/** The tables this table inherits from, or is a partition of. */
export const PARENTS_SQL = `select pn.nspname::text || '.' || pc.relname::text as parent
  from pg_inherits i
  join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace
 where n.nspname = $1 and c.relname = $2`;

/** Members of the tree below the named table that also have a parent OUTSIDE the tree (multiple inheritance). */
export const OUTSIDE_PARENTS_SQL = `with recursive t as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2
    union
    select i.inhrelid from pg_inherits i join t on i.inhparent = t.oid)
  select cn.nspname::text || '.' || cc.relname::text as member, pn.nspname::text || '.' || pc.relname::text as outside_parent
    from pg_inherits i join t on t.oid = i.inhrelid
    join pg_class cc on cc.oid = i.inhrelid join pg_namespace cn on cn.oid = cc.relnamespace
    join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace
   where i.inhparent not in (select oid from t)`;

/**
 * Things below or on the table that would keep a copy of an original value outside the rewritten columns: an UPDATE rule
 * (rules are not switched off with the triggers) and a materialized view over the table.
 */
export const COPIERS_SQL = `with recursive t as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2
    union
    select i.inhrelid from pg_inherits i join t on i.inhparent = t.oid),
  deps as (
    select v.oid, v.relkind from pg_depend d
      join pg_rewrite w on w.oid = d.objid and d.classid = 'pg_rewrite'::regclass
      join pg_class v on v.oid = w.ev_class and v.relkind in ('v', 'm')
     where d.refclassid = 'pg_class'::regclass and d.refobjid in (select oid from t)
    union
    select v.oid, v.relkind from deps x
      join pg_depend d on d.refobjid = x.oid and d.refclassid = 'pg_class'::regclass
      join pg_rewrite w on w.oid = d.objid and d.classid = 'pg_rewrite'::regclass
      join pg_class v on v.oid = w.ev_class and v.relkind in ('v', 'm') and v.oid <> x.oid)
  select 'rule ' || r.rulename::text || ' on ' || r.ev_class::regclass::text as what from pg_rewrite r
   where r.ev_class in (select oid from t) and r.rulename <> '_RETURN' and r.ev_type in ('2', '*')
  union all
  select 'materialized view ' || oid::regclass::text from deps where relkind = 'm'`;

/** Every foreign key column pair in the database, as schema.table.column strings. */
export const FK_PAIRS_SQL = `select cn.nspname::text || '.' || cc.relname::text || '.' || a.attname::text as fk_child,
       pn.nspname::text || '.' || pc.relname::text || '.' || pa.attname::text as fk_parent
  from pg_constraint k
  join pg_class cc on cc.oid = k.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
  join pg_class pc on pc.oid = k.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
  cross join lateral unnest(k.conkey, k.confkey) as u(ck, fk)
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.ck
  join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = u.fk
 where k.contype = 'f'`;

/**
 * Foreign key actions are off while the rewrite runs, and a key ties two columns to the same original values. Every column
 * linked to a masked column, in either direction and along a chain of keys, keeps the originals unless it is masked in the same
 * run. (The same input gives the same output, so the keys still match afterwards.) A column of a table below a masked table
 * counts as masked when the column has the same name.
 */
export async function linkProblems(db: Db, masks: MaskSpec[]): Promise<string[]> {
  const covered = new Set<string>();
  for (const m of masks) {
    const tree = (await db.query(TREE_SQL, [m.schema, m.table])).rows as { schema: string; name: string }[];
    for (const t of tree) covered.add(`${t.schema}.${t.name}.${m.column}`);
  }
  const pairs = (await db.query(FK_PAIRS_SQL)).rows as { fk_child: string; fk_parent: string }[];
  const adj = new Map<string, string[]>();
  const link = (x: string, y: string): void => {
    adj.set(x, [...(adj.get(x) ?? []), y]);
  };
  for (const p of pairs) {
    link(p.fk_child, p.fk_parent);
    link(p.fk_parent, p.fk_child);
  }
  const seen = new Set<string>(covered);
  const queue = [...covered];
  const found: string[] = [];
  while (queue.length) {
    const x = queue.shift()!;
    for (const y of adj.get(x) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      queue.push(y);
      found.push(`${y} is tied to ${x} by a foreign key`);
    }
  }
  return found.length ? [`${found.join('; ')}, and would keep the original values. Mask each of them in the same run`] : [];
}

async function treeProblem(db: Db, m: MaskSpec): Promise<string | null> {
  const out = (await db.query(OUTSIDE_PARENTS_SQL, [m.schema, m.table])).rows as { member: string; outside_parent: string }[];
  if (out.length) {
    return `${out.map((x) => `${x.member} also inherits from ${x.outside_parent}`).join(', ')}, which is outside the tree of ${m.schema}.${m.table}, and the statistics of that parent would keep the original values. Mask the root of every tree that holds this data`;
  }
  const copiers = ((await db.query(COPIERS_SQL, [m.schema, m.table])).rows as { what: string }[]).map((x) => x.what);
  if (copiers.length) {
    return `${copiers.join(', ')} would keep a copy of the original values outside the rewritten column. Drop it from the files, or leave this column unmasked`;
  }
  return null;
}

export interface MaskedColumn {
  column: string;
  strategy: MaskStrategy;
  rows: number;
}

/**
 * Applies the masks to a database with the connection given (the master, a labelled copy). One transaction per column.
 * Row security is off in the session, so a policy cannot hide a row from the rewrite (a table that would be filtered
 * raises an error instead). Triggers and foreign key checks are switched off (session_replication_role = replica), so an
 * audit trigger cannot copy the old value elsewhere. That needs a superuser, and the run stops without one.
 * After each rewrite the same session checks that every non-null row was touched and that no original value is left.
 */
export async function applyMasks(db: Db, masks: MaskSpec[], salt: string = randomBytes(16).toString('hex')): Promise<MaskedColumn[]> {
  // Everything that can be refused is checked for ALL columns before the first one is rewritten.
  const problems = await validateMasks(db, masks);
  if (problems.length) throw new Error(`masking stopped: ${problems.join('; ')}`);
  const done: MaskedColumn[] = [];
  for (const m of masks) {
    const label = maskText(m);
    const f = (await factsOf(db, m)) as ColumnFacts;
    const tbl = `${qi(m.schema)}.${qi(m.table)}`;
    const col = qi(m.column);
    const tree = (await db.query(TREE_SQL, [m.schema, m.table])).rows as { schema: string; name: string; kind: string }[];
    const odd = tree.filter((t) => t.kind !== 'r' && t.kind !== 'p');
    if (odd.length) {
      // An UPDATE through the parent would be sent to a foreign table's server, or hit a kind of relation that is not rewritten here.
      throw new Error(`masking stopped: ${label} has below it ${odd.map((t) => `${t.schema}.${t.name} (relkind ${t.kind})`).join(', ')}, which cannot be masked and cleaned safely`);
    }
    // The snapshot lives for the whole column, past the commit, so the statistics can be checked against it.
    await db.query('drop table if exists pg_temp._sab_mask');
    try {
      await db.query('begin');
      try {
        await db.query('set local row_security = off');
        try {
          await db.query("set local session_replication_role = 'replica'");
        } catch (e) {
          throw new Error(`masking needs a superuser to switch triggers off while it rewrites ${label} (${(e as Error).message})`);
        }
        await db.query(`create temp table _sab_mask as select ${col} as v from ${tbl} where ${col} is not null`);
        const before = Number((await db.query('select count(*) as n from _sab_mask')).rows[0].n);
        const set = m.strategy === 'null' ? 'null' : scrambleExpr(col, f, salt);
        const upd = await db.query(`update ${tbl} set ${col} = ${set} where ${col} is not null`);
        if (Number(upd.rowCount) !== before) {
          throw new Error(`rewrote ${upd.rowCount} row(s) of ${label}, expected ${before}`);
        }
        const left =
          m.strategy === 'null'
            ? Number((await db.query(`select count(*) as n from ${tbl} where ${col} is not null`)).rows[0].n)
            : Number((await db.query(`select count(*) as n from ${tbl} where ${col} is not null and ${col} in (select v from _sab_mask)`)).rows[0].n);
        if (left !== 0) throw new Error(`${left} row(s) of ${label} still hold an original value after the rewrite`);
        await db.query('commit');
        done.push({ column: label, strategy: m.strategy, rows: before });
      } catch (e) {
        await db.query('rollback').catch(() => {});
        throw e;
      }
      // The rewrite leaves the old values in dead rows, in index pages and in the planner statistics (pg_statistic holds
      // sample values and histogram bounds). A copy is made from these files, so all three must go before any copy.
      // VACUUM cannot run in a transaction.
      for (const t of tree) {
        const member = `${qi(t.schema)}.${qi(t.name)}`;
        // A partitioned table holds no rows itself: ANALYZE it, and clean each partition on its own line of this loop.
        await db.query(t.kind === 'p' ? `analyze ${member}` : `vacuum (full, analyze) ${member}`);
      }
      // ANALYZE replaced the statistics rows. The old versions are dead rows in the catalog tables until they are rewritten too.
      await db.query('vacuum (full) pg_catalog.pg_statistic');
      await db.query('vacuum (full) pg_catalog.pg_statistic_ext_data');
      for (const t of tree) {
        const stats = Number((await db.query(STATS_SQL, [t.schema, t.name, m.column])).rows[0].n);
        if (stats !== 0) {
          throw new Error(`${stats} original value(s) of ${label} are still in the planner statistics of ${t.schema}.${t.name} (pg_stats, pg_stats_ext) after VACUUM FULL and ANALYZE`);
        }
      }
    } catch (e) {
      throw new Error(`masking ${label} failed, so the run stops before any test: ${(e as Error).message}`);
    } finally {
      await db.query('drop table if exists pg_temp._sab_mask').catch(() => {});
    }
  }
  return done;
}
