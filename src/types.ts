export type PolicyCmd = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface Policy {
  schema: string;
  table: string;
  name: string;
  cmd: PolicyCmd;
  permissive: boolean;
  /** Role names. Empty means PUBLIC. */
  roles: string[];
  qual: string | null;
  withCheck: string | null;
}

export interface TableInfo {
  schema: string;
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  column: string;
  type: string;
}

export interface Catalogue {
  policies: Policy[];
  tables: TableInfo[];
  columns: ColumnInfo[];
}

export type BreakKind =
  | 'drop-policy'
  | 'using-true'
  | 'check-removed'
  | 'conjunct-removed'
  | 'column-swapped'
  | 'restrictive-to-permissive'
  | 'rls-disabled';

export interface Break {
  /** Stable, human-readable id, e.g. `public.documents/members read documents/using-true`. */
  id: string;
  kind: BreakKind;
  schema: string;
  table: string;
  /** Null for table-level breaks. */
  policy: string | null;
  /** What was done, in one line. */
  label: string;
  /** What an attacker or a bug gets once this break is in place. */
  effect: string;
  /** DDL that applies the break. */
  apply: string[];
}

export type Outcome = 'caught' | 'missed' | 'skipped' | 'error';

export interface BreakResult {
  brk: Break;
  outcome: Outcome;
  /** Why it was skipped or errored. */
  note?: string;
  ms: number;
}

export type Severity = 'FAIL' | 'WARN';

export interface Finding {
  check: 'function-execute' | 'role-membership' | 'inert-column-grant' | 'definer-current-user';
  severity: Severity;
  title: string;
  detail: string;
}
