# RLS Saboteur

[![CI](https://github.com/mattmuller/rls-saboteur/actions/workflows/ci.yml/badge.svg)](https://github.com/mattmuller/rls-saboteur/actions/workflows/ci.yml)

Your Supabase RLS tests pass. This tool checks whether they would fail if a policy broke.

It breaks each row level security policy on purpose, one at a time, and runs your tests. Every break the tests did not notice is listed as **missed**. A missed break is a real hole: a policy that could go wrong with no test to say so.

This is mutation testing for Postgres policies. Stryker and PIT do it for application code. Tools like rlsautotest and SupaShield write RLS tests. RLS Saboteur checks the tests, whoever wrote them.

```sh
supabase start
npx rls-saboteur
```

No configuration. It reads the database port from `supabase/config.toml`, every policy from the Postgres catalogue, and your pgTAP files from `supabase/tests`.

Against a local Supabase stack, you may need `--admin-url postgres://supabase_admin:postgres@127.0.0.1:<port>/postgres`. Without it, the copy step can fail with "postgres still has connections that this role cannot close". Use the database port from `supabase status`.

## What it will never do

Your database is never touched. The tool works only on temporary copies. These are the guarantees, each with the test that proves it.

- **It never changes the database you point it at.** It sends that database nothing but plain reads (`SELECT`). The connection is also opened read-only, so Postgres itself refuses a write. Proof: `guard: the source database is read-only` (test/guard.test.ts) and `source-untouched` (test/matrix/source-untouched.test.ts, which compares policies, table flags, the database row, its settings and its roles before and after a full run).
- **It never changes a setting of that database.** There is no `ALTER DATABASE` step. Proof: `guard: the admin connection > refuses anything else, including changing the source database`.
- **It only ever drops databases it made itself.** Every copy is labelled `rls-saboteur copy <random token>` the moment it exists. A drop is allowed only when the name starts with `saboteur_`, is not your database, and the label matches this run (or an earlier run whose process has died). Proof: `guard: the admin connection` (refuses unprefixed, source and unlabelled names) and `droppable`.
- **It never closes your connections on a remote host, or when you gave `--no-terminate` or the remote flag.** On a local database it may close other sessions for a moment to take the first copy, and only after you say yes. Proof: `refuses to close sessions when terminating is not allowed` and `no-terminate-with-remote-flag`.
- **A crash cannot leave your database changed.** There is nothing to undo. Proof: `crash-during-first-copy` kills the process with `kill -9` in the middle of the first copy, then checks the source accepts connections and is unchanged.
- **It never runs without asking, unless you say `--yes`.** Proof: `confirmation steps` (test/confirm.test.ts), `run asks before it copies anything` (test/run-confirm.test.ts) and `no-prompt-without-yes`.

What this does not cover: the test command you give it (`--test`, or the `test` value in `.rls-saboteur.json`) is your code and runs as you. It is passed the address of a copy only, but it is a shell command. The tool shows it to you before it runs when it comes from the config file.

Versions before 0.2.0 had an `--isolation in-place` mode that edited your real database. It was removed in 0.2.0.

### Confirmation steps

Before anything is copied, the tool prints a plan and waits for you:

```
Plan
  Database: postgres on 127.0.0.1 (local)
  It will: make temporary copies of it, break 42 policies in the copies, run: supabase/tests/*.sql  (pgTAP, run with supabase test db)
  It will not change this database.
Continue? (y/N)
```

The default is No. An empty answer is No.

1. **The plan.** As above.
2. **Closing other sessions.** If the first copy needs it (local databases only): `N other connection(s) are open to <db> (<application names>). Close them for a moment? They reconnect by themselves. (y/N)`. No stops the run with the explanation.
3. **A test command from `.rls-saboteur.json`.** The exact command is shown and you are asked before it runs. A command passed with `--test` on the command line is not asked about, because you typed it.

With no terminal (stdin or stdout is not a TTY, or `CI=true`) the tool never prompts and never waits. Without `--yes` it exits 2 and names `--yes`. `--yes` approves all three questions, so pass it only for a run whose plan you have read. The GitHub Action passes `--yes`, because the workflow is your own.

## Before and after

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

```
```

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

## How it works

1. **Discover.** The database URL comes from `supabase/config.toml` (default port 54322) or `--db-url`. Policies come from `pg_policy`. Tests are the `.sql` files in `supabase/tests`.
2. **Plan.** It shows the plan and asks (see Confirmation steps).
3. **Copy and baseline.** It copies the database once into a labelled master template. It runs the tests once, unchanged, on a copy. If they fail or cannot run, it stops with exit 2 and says so. Then, for each break, it makes a throwaway database with `CREATE DATABASE ... TEMPLATE`, applies the break with DDL, runs the tests against that copy, and drops it. Your database is not changed.
4. **Report.** Caught means a test failed. Missed means the tests passed. Error means the tests could not run, for example a crashed psql or a refused connection. An error is never a catch.

### How tests are pointed at a copy

- Default runner: `supabase test db --db-url <copy url>`. The Supabase CLI takes a connection string, so it runs the same pgTAP suite against the copy.
- No Supabase CLI: `--runner psql` runs each `.sql` file with psql against the copy. It installs pgTAP in the copy. A file fails on a `not ok` line, a `# Looks like you failed` line, or a plan mismatch. Exit 3 (a SQL statement failed under `ON_ERROR_STOP`) also counts as a failure, because the unbroken baseline ran the same files and passed. Any other non-zero exit (1 fatal, 2 connection lost) or a signal is an error. The Supabase runner needs TAP evidence for a failure.
- Any other command: `--test "pnpm test:rls"`. The copy is passed as `$DATABASE_URL`, `$SABOTEUR_DB_URL` and the `PG*` variables. Use `$DATABASE_URL` in your command. `{{db_url}}` is also replaced inside the command string, shell-quoted so the URL arrives unchanged (single quotes on macOS and Linux, double quotes on Windows). On Windows a URL holding `"`, `%` or `!` is refused, so use `%DATABASE_URL%` there. The command must follow the exit code contract below.

**Exit code contract for `--test`.** Exit `0` means every test passed. Exit `1` means a test failed. Any other exit code, or a kill by a signal, means the tests could not run. This is the pytest convention. A break counts as caught only on exit `1`. Your command must exit `1`, and only `1`, when an assertion fails. If it exits `2` for "could not parse a result", the break is an error.

### The first copy and open connections

Postgres refuses to copy a database while anyone else is connected to it. A running local Supabase always has connections open (auth, REST, realtime), so a direct copy fails with "source database is being accessed by other users".

RLS Saboteur handles this once, at the start, on a local database only, and only after you answer yes. It closes the other connections for about a second, makes the master template, and lets them reconnect. It prints a note when it did so. It changes no setting of your database to do this. With `--no-terminate`, with the remote flag, or on a remote host it never closes anything: a busy database is an error that tells you how to free it.

A stock local Supabase stack has one more catch. The cron scheduler keeps a connection open as a superuser, and the normal `postgres` role cannot close it. So when the host is local and `supabase/config.toml` exists, RLS Saboteur tries the CLI's documented local superuser (`supabase_admin`, local default password) on the same host and port. It uses that role only to copy and drop databases, and prints one line saying so. If that login fails, pass your own with `--admin-url <superuser url>`.

If no copy can be made, it stops with exit 2 and your database is untouched. Pass `--admin-url` with a superuser URL, or stop the services that use the database.

### Security notes

- **`--test` and the `test` value in `.rls-saboteur.json` run as shell commands**, the same way `package.json` scripts do. Run the tool only in projects you trust, and never with a config file you did not read.
- **In CI, never pass untrusted text to the Action's `extra-args` input.** It becomes command-line options. Pull request titles, branch names and comment bodies are untrusted. The same goes for the `test` input.
- **Give the workflow the least permission.** Set `permissions: contents: read` on any workflow that uses the Action.
- Passwords are passed to `psql` and the Supabase CLI in `PGPASSWORD`, not on the command line.

On the demo project, 42 breaks took about 35 seconds on copies with `--jobs 2`.

## Plain Postgres (no Supabase)

Nothing in the tool needs Supabase. Without it you must say three things the Supabase defaults would have said for you:

```sh
npx rls-saboteur \
  --db-url postgres://app_owner:secret@127.0.0.1:5432/mydb \
  --admin-url postgres://postgres:secret@127.0.0.1:5432/postgres \
  --runner psql \
  --tests-dir tests
```

| Flag | Why you need it without Supabase |
|---|---|
| `--db-url` | There is no `supabase/config.toml` to read the port from. |
| `--runner psql` | Without it the tool uses the Supabase CLI whenever it is installed. `psql` must be on your PATH. |
| `--tests-dir <dir>` | The default directory is `supabase/tests`. |
| `--admin-url <superuser url>` | Only when your `--db-url` role cannot `CREATE DATABASE`, or other sessions stay connected. The zero-config superuser fallback applies to a local Supabase only. A superuser `--db-url` works without it. |

Notes:

- The `--db-url` role must own the tables, because each break is an `ALTER POLICY` or `DROP POLICY`. It does not need to be a superuser.
- The `psql` runner installs the `pgtap` extension in its copies. If pgTAP is not installed on the server (`postgresql-<version>-pgtap`), use `--test "<command>"` instead. A plain SQL script that raises on failure works there. Psql exits 3 when a script raises, so map it: `psql -v ON_ERROR_STOP=1 -f t.sql; c=$?; [ $c -eq 3 ] && exit 1; exit $c`. The runner does not need pgTAP in that mode.
- Tenancy through `current_setting('app.tenant_id')` is fully covered, except one break kind: "auth.uid() compared with the wrong column" is generated only for `auth.uid()`. A policy that reads a setting gets every other break.

## Checks that need no tests

These run on every invocation, and alone with `--checks-only`. They read the catalogue and call nothing.

| Check | What goes wrong |
|---|---|
| A policy calls a function its role cannot EXECUTE | Every query on the table fails for that role. A grep of the code cannot see it, because the caller is a policy. |
| A custom role is a member of anon or authenticated | The role inherits everything, and every restriction on it stops meaning anything. |
| A column-level grant under a table-level grant | Column privileges add to table privileges. The column grant or REVOKE changes nothing. A REVOKE leaves no trace in the catalogue, so the check reports the visible symptom: a role with a table-level privilege and column-level entries for the same privilege. |
| `current_user` inside a SECURITY DEFINER function | It is always the function owner, never the caller, so the check always passes. |

A `FAIL` makes the exit code 1.

## Options

```
--db-url <url>        Database to read. Default: local Supabase from supabase/config.toml
--schemas <a,b>       Schemas to cover. Default: public
--test "<command>"    Run this command instead of "supabase test db"
--runner <name>       auto, supabase or psql
--jobs <n>            Breaks run in parallel on copies. Default: 2
--threshold <pct>     Fail below this score. Default: 100
--only-related        Per break, run only the test files that mention the table
--isolation template  Accepted for old scripts. `in-place` was removed in 0.2.0.
--admin-url <url>     Superuser URL used only to copy and drop databases
--tests-dir <dir>     Directory of pgTAP files. Default: supabase/tests
--no-terminate        Never close other connections for the first copy
--yes                 Approve the plan, closing local sessions and a config-file test command without asking (needed without a terminal)
--filter <text>       Only breaks whose id contains this text
--checks-only         Only the checks that need no tests
--dry-run             List the breaks and stop
--json                JSON report on stdout
--json-file <path>    Write the JSON report to a file
--report <path>       Markdown report. Default: saboteur-report.md
```

Exit codes: `0` passed, `1` below the threshold or a check failed, `2` could not check (tests fail unchanged, no tests, refused database, no connection).

The score is caught divided by caught plus missed. Breaks that could not be applied, errored, timed out, or were skipped by config are listed in the report and not counted. If any break errored, the run prints a warning, because the score may be too high. Fix the cause and run again.

`--only-related` is faster on big suites. It maps test files to tables by the table name appearing in the file. A test that reaches a table only through a function is not mapped, so use it when your tests name their tables.

### Optional config

A `.rls-saboteur.json` in the project root:

```json
{
  "schemas": ["public"],
  "threshold": 95,
  "skip": [{ "policy": "public read of the status page", "reason": "Equivalent to the original: the table is public on purpose." }]
}
```

Every skip needs a written reason, and skipped breaks are listed in the report.

## Safety

- It refuses any database that is not local (`localhost`, `127.0.0.1`, `::1`, the Docker host) unless you pass `--allow-remote-i-understand-this-locks-tables`. Breaking a policy on a live database takes a lock and stalls it.
- It never reads your rows. It reads the catalogue and runs your own tests.
- Copies are named `saboteur_<pid>_<n>`, labelled, and dropped after each break. A run that dies leaves none behind that the next run does not sweep. A copy is swept only if it is labelled and its process is dead. See "What it will never do".
- Test output is scrubbed of connection strings and passwords before it reaches a report.

## Claude Code

`plugin/` is a Claude Code plugin with a `/sabotage` command and a skill. It runs the tool, shows the report, writes a pgTAP test for each missed break, and re-runs to prove each break is now caught.

```
/plugin marketplace add mattmuller/rls-saboteur
/plugin install rls-saboteur@rls-saboteur
/sabotage
```

## GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: mattmuller/rls-saboteur@v1
  with:
    threshold: 95
```

It starts the database container only, runs the tool, writes the report to the job summary, and fails the job below the threshold.

The Action passes `--yes`. A CI run has no terminal to ask on, and the workflow file is your own approval of the plan: temporary copies of the CI database, which is thrown away with the job.

### Security

- The action installs `rls-saboteur` from npm with `npx` and runs your tests with the Supabase CLI. It runs nothing else.
- Inputs are never interpolated into scripts. Each one is passed through an environment variable and quoted, so a crafted input cannot inject a command.
- `version` defaults to the version the action release ships with, and `supabase/setup-cli` is pinned. Pin the action itself to a tag or a commit.
- The release step must keep the `version` default in `action.yml` equal to `package.json`.

## Tested against

`npm run test:matrix` runs six synthetic databases end to end, on PostgreSQL 16 and 17 (official `postgres` images plus pgTAP). Each fixture has its own tests and an `expected.json` that lists every break that must be caught and every break that must be missed. CI runs the same matrix.

| Fixture | What it covers | Caught / missed |
|---|---|---|
| `plain-postgres` | No `auth` schema, no `anon` or `authenticated`. Tenancy by `current_setting`, roles `app_user` and `app_admin`, a non-superuser `--db-url` plus `--admin-url`, `--runner psql`. | 11 / 8 |
| `supabase-style` | A stub `auth.uid()`, `anon` and `authenticated`, the owner-column swap. | 11 / 9 |
| `restrictive-and-for-all` | RESTRICTIVE and PERMISSIVE on one table, `FOR ALL`, several roles per policy, `TO PUBLIC`. Driven by `--test` with a plain SQL script, and `--threshold`. | 13 / 4 |
| `function-policies` | Policies calling SECURITY DEFINER helpers. One helper its role cannot EXECUTE, reported by the catalogue check and never called. | 3 / 8, 2 FAIL findings |
| `odd-identifiers` | Mixed-case and spaced table and column names, a policy name with quotes and one with a slash, a non-public schema through `--schemas`. | 9 / 6 |
| `partitioned` | RLS on a partitioned table and on its partitions. | 8 / 3 |

The "missed" breaks are deliberate: each fixture leaves something untested so the test can fail if the tool stops finding it. The counts are identical on 16 and 17.

Not covered by the matrix, so not promised:

- The Supabase CLI runner (`supabase test db`). CI has no Supabase stack.
- PostgreSQL older than 16, and managed services (RDS, Cloud SQL, Neon). A role that cannot create databases needs `--admin-url`.
- Windows.
- The column swap is only generated for `auth.uid()` comparisons (see Plain Postgres).
- Policies on a partition are broken separately from the parent's, because Postgres applies them separately. A partition with no RLS of its own has nothing to break.

## Related tools

- [SupaShield](https://github.com/Rodrigotari1/supashield) is a command-line tool that audits and lints RLS, maps access per role, snapshots policies, and exports pgTAP tests.
- [rlsautotest](https://github.com/unitautogen/rlsautotest) generates a pgTAP suite and its seed data from your policies, including two-tenant isolation.
- [rlsgrid](https://github.com/matte97p/rlsgrid) maps role, table and operation, then fuzzes cross-tenant reads and writes.
- [splinter](https://github.com/supabase/splinter) is Supabase's own linter. It checks database settings and powers the Security Advisor.
- [supabase-test-helpers](https://github.com/usebasejump/supabase-test-helpers) provides pgTAP helpers for signing in as a user inside a test.

RLS Saboteur works on top of the tests that SupaShield and rlsautotest generate: generate a suite with one of them, then run RLS Saboteur to see which breaks that suite misses.

## Develop

```sh
npm install
npm test            # unit tests
npm run build
npm run test:e2e    # needs a local Postgres; set SABOTEUR_E2E_URL
npm run test:matrix # needs Docker; starts and removes rls-saboteur-ci-16 and -17
```

MIT. Copyright Matt Muller.
