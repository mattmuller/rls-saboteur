# How it works

## What "breaking a policy" means

| Break | What it simulates |
|---|---|
| Drop the policy | A migration that forgot to recreate it. |
| USING becomes true | The "temporary" open policy that shipped. |
| Remove WITH CHECK | Users can write rows they could never read, for example into another tenant. |
| Remove one condition from an AND | A tenant check lost in a refactor. One break per condition. |
| auth.uid() compared with the wrong column | The owner check on the wrong field. |
| Restrictive becomes permissive | A "hide" policy that hides nothing. Postgres ORs permissive policies together. |
| RLS switched off on the table | The table that was never locked. |

`--dry-run` prints the full list of breaks for your project and runs nothing.

## How a run goes

1. **Discover.** The database URL comes from `supabase/config.toml` (default port 54322) or `--db-url`. Policies come from `pg_policy`. Tests are the `.sql` files in `supabase/tests`.
2. **Plan.** It shows the plan and asks (see [Confirmation steps](safety.md#confirmation-steps)).
3. **Copy and baseline.** It copies the database once into a labelled master template. It runs the tests once, unchanged, on a copy. If they fail or cannot run, it stops with exit 2 and says so. Then, for each break, it makes a throwaway database with `CREATE DATABASE ... TEMPLATE`, applies the break with DDL, runs the tests against that copy, and drops it. Your database is not changed.
4. **Report.** Caught means a test failed. Missed means the tests passed. Error means the tests could not run, for example a crashed psql or a refused connection. An error is never a catch.

### How tests are pointed at a copy

- Default runner: `supabase test db --db-url <copy url>`. The Supabase CLI takes a connection string, so it runs the same pgTAP suite against the copy.
- No Supabase CLI: `--runner psql` runs each `.sql` file with psql against the copy. It installs pgTAP in the copy. A file fails on a `not ok` line, a `# Looks like you failed` line, or a plan mismatch. Exit 3 (a SQL statement failed under `ON_ERROR_STOP`) also counts as a failure, because the unbroken baseline ran the same files and passed. Any other non-zero exit (1 fatal, 2 connection lost) or a signal is an error. The Supabase runner needs TAP evidence for a failure.
- Any other command: `--test "pnpm test:rls"`. The copy is passed as `$DATABASE_URL`, `$SABOTEUR_DB_URL` and the `PG*` variables. Use `$DATABASE_URL` in your command. `{{db_url}}` is also replaced inside the command string, shell-quoted so the URL arrives unchanged (single quotes on macOS and Linux, double quotes on Windows). On Windows a URL holding `"`, `%` or `!` is refused, so use `%DATABASE_URL%` there. The command must follow the exit code contract below.

**Exit code contract for `--test`.** Exit `0` means every test passed. Exit `1` means a test failed. Any other exit code, or a kill by a signal, means the tests could not run. This is the pytest convention. A break counts as caught only on exit `1`. Your command must exit `1`, and only `1`, when an assertion fails. If it exits `2` for "could not parse a result", the break is an error.

### The first copy and open connections

Postgres refuses to copy a database while anyone else is connected to it. A running local Supabase always has connections open (auth, REST, realtime), so a direct copy fails with "source database is being accessed by other users".

RLS Saboteur handles this once, at the start, on a local database only, and only after you answer yes. With your separate yes (the question, or `--close-sessions`; `--yes` is not enough) it closes the other connections for about a second, makes the master template, and lets them reconnect. It prints a note when it did so. It changes no setting of your database to do this. With `--no-terminate`, with the remote flag, or on a remote host it never closes anything: a busy database is an error that tells you how to free it.

A stock local Supabase stack has one more catch. The cron scheduler keeps a connection open as a superuser, and the normal `postgres` role cannot close it. So when the host is local and `supabase/config.toml` exists, RLS Saboteur tries the CLI's documented local superuser (`supabase_admin`, local default password) on the same host and port. It uses that role only to copy and drop databases, and prints one line saying so. If that login fails, pass your own with `--admin-url <superuser url>`.

If no copy can be made, it stops with exit 2 and your database is untouched. Pass `--admin-url` with a superuser URL, or stop the services that use the database.

## Worked example

The `examples/demo` project is a small multi-tenant app (orgs, members, documents, invoices) with a pgTAP suite that looks complete and passes.

**Before.** The suite in `examples/demo/supabase/tests`:

```
$ cd examples/demo
$ npx rls-saboteur
Database   postgres://127.0.0.1:55322/postgres  (local Supabase, found from supabase/config.toml)
Tests      supabase/tests/*.sql  (pgTAP, run with supabase test db)
Policies   12 on 4 tables in public
Baseline   all 25 tests pass
Sabotage   breaking each policy in turn and re-running the tests  (42 breaks, 2 at a time, on database copies)
  note: Using the local Supabase superuser (supabase_admin, the CLI default) only to copy and drop databases.
  note: Closed 2 other connection(s) to "postgres" for a moment to copy it. Local services reconnect by themselves.
  caught  36 / 42
  MISSED   6 / 42  your tests still pass with these policies broken
  MISSED  documents  "authors delete own documents"
          USING (author_id = auth.uid())
          break: USING replaced with true  → any authenticated deletes every row in the table, whatever tenant it belongs to
          1 test file(s) mention documents, and none fails with this break.
  MISSED  documents  "authors update own documents"
          USING (author_id = auth.uid()) WITH CHECK (author_id = auth.uid())
          break: USING replaced with true  → any authenticated updates every row in the table, whatever tenant it belongs to
          1 test file(s) mention documents, and none fails with this break.
  MISSED  invoices  "admins create invoices"
          WITH CHECK (is_org_admin(org_id) AND (issued_by = auth.uid()))
          break: WITH CHECK condition removed: issued_by = auth.uid()  → rows that fail this condition now pass the policy
          1 test file(s) mention invoices, and none fails with this break.
  ... 3 more in saboteur-report.md
Checks without tests
  ok    no problems found in grants, roles or functions
Score  86%   exit 1 (threshold 100%)
```

The other three misses are in `saboteur-report.md`. All six:

- public.documents "authors delete own documents": USING replaced with true
- public.documents "authors update own documents": USING replaced with true
- public.invoices "admins create invoices": WITH CHECK condition removed: issued_by = auth.uid()
- public.invoices "admins update invoices": USING replaced with true
- public.invoices "admins update invoices": WITH CHECK removed
- public.members "members read co-members": USING replaced with true

**After.** The same project with the tests in `examples/demo/fixed/tests`, which add one test for each miss:

```
$ npx rls-saboteur --tests-dir fixed/tests
Database   postgres://127.0.0.1:55322/postgres  (local Supabase, found from supabase/config.toml)
Tests      fixed/tests/*.sql  (pgTAP, run with supabase test db)
Policies   12 on 4 tables in public
Baseline   all 31 tests pass
Sabotage   breaking each policy in turn and re-running the tests  (42 breaks, 2 at a time, on database copies)
  note: Using the local Supabase superuser (supabase_admin, the CLI default) only to copy and drop databases.
  note: Closed 2 other connection(s) to "postgres" for a moment to copy it. Local services reconnect by themselves.
  caught  42 / 42
  MISSED   0 / 42  your tests still pass with these policies broken
Checks without tests
  ok    no problems found in grants, roles or functions
Score  100%   exit 0 (threshold 100%)
```

On the demo project, 42 breaks took about 35 seconds on copies with `--jobs 2`.
