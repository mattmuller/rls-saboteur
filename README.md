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

It never changes the database you point it at. It does read it: your rows are copied into temporary databases on the same server, which are dropped afterwards.

How this is enforced: every connection the tool opens goes through one guard (`src/guard.ts`). The guard is an allowlist of the statements the tool itself sends. On your database it allows plain reads (`SELECT`) and nothing else, and the session is also read-only, so Postgres itself refuses a write. On the admin connection it allows only `CREATE DATABASE`, `COMMENT ON DATABASE`, `DROP DATABASE`, closing sessions on your database and cancelling the tool's own `CREATE DATABASE`, each in one exact shape. The guard does not inspect your test files or your test command: they are your code (see "What a copy can still do").

These are the guarantees. Each names the tests that check it, by their exact names. Unit tests run with `npx vitest run` (test/guard.test.ts and test/hardening.test.ts). Matrix tests run against real PostgreSQL 16 and 17 with `npm run test:matrix` (test/matrix/hardening.test.ts and test/matrix/source-untouched.test.ts).

- **It never changes the database you point it at.** It sends that database nothing but plain reads. Proof: `guard: the source database is read-only` (unit) and `source-untouched: a full run leaves the source catalogue byte for byte the same` (matrix, which compares policies, table flags, the database row, its settings and its roles before and after a full run).
- **It never changes a setting of that database.** There is no `ALTER DATABASE` step. Proof: `guard: the admin connection > refuses anything else, including changing the source database` (unit) and `source-untouched-busy: closing other sessions leaves the source settings alone, and says so` (matrix).
- **It only ever drops databases it made itself.** A copy is named `saboteur_<host id>_<pid>_<run token>_tpl` or `..._<n>`, so its maker is in its name even if its label was never written. It is also labelled `rls-saboteur copy <run token> host=<host id>` once it exists. A drop is allowed only when the database is not yours, and it was made by this run, or by a process of this host that is dead. A copy made by another host (the host id covers the machine, the boot and, on Linux, the pid namespace) or by a live process is never dropped. A `--db-url` whose database name looks like a saboteur copy is refused. Proof: `guard: the admin connection`, `droppable (the one rule behind every drop)`, `F: a pid is only judged on the host that owns it`, `1a: the identity of a copy is in its NAME, so a missing label does not hide it` (unit) and `F: only dead copies of this host are swept`, `an unlabelled copy of a dead pid on this host is swept; one of another host, or of a live pid, is not`, `a --db-url that names a saboteur copy is refused with exit 2` (matrix).
- **An interrupt leaves no copy behind.** On Ctrl-C or SIGTERM during `CREATE DATABASE`, the tool cancels its own `CREATE` (`pg_cancel_backend`, allowed only for the backend running it), waits up to 30 seconds for the server to stop, and drops the copy. If it cannot, it prints the database name and the `drop database` command and exits 1. After `kill -9` the server may finish the copy; the next run drops it by its name. Proof: `H4: an interrupt during CREATE DATABASE cancels it, waits for it, then drops by name` and `1b: pg_cancel_backend is allowed only for the backend running our own CREATE` (unit), and in the matrix `1: an interrupted copy never leaves a database behind` (SIGINT and SIGTERM during the first copy, SIGINT during a per-break copy, and `kill -9`, each on a source large enough that the copy takes more than a second).
- **Every connection and every test runner lands on the database it names, and no other.** A `--db-url` or `--admin-url` with a connection parameter in its query string (`dbname`, `host`, `options`, `user`, `port`, `service` and the like) is refused with exit 2, because psql and the Supabase CLI let those override the URL. Every copy URL is built from parsed parts. Every connection checks `current_database()`, and a test runner is started with the copy in `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` and a URL without a query string. Proof: `A: connection URLs`, `A: every connection must land on the database it names` (unit) and, against real psql, `the psql runner installs pgTAP only in the database named by the path, never in ?dbname=` and `the CLI refuses ?dbname= on --db-url with exit 2 and creates nothing` (matrix; vitest prints `dbname` in place of `%s`).
- **A test command sees no variable that names another database.** The tool removes every environment variable whose name contains `DATABASE`, `DB_URL`, `DBURL`, `DB_CONNECTION`, `DIRECT_URL`, `POSTGRES`, `SUPABASE` or `SERVICE_ROLE` (any case), and every `PG*` variable. Then it sets `DATABASE_URL`, `SABOTEUR_DB_URL` and `PG*` to the copy. The plan lists the removed names, never the values. **Files your test framework loads itself are not controlled.** A `.env`, `.env.local`, `.env.test` or `.env.test.local` in the working directory that mentions `DATABASE_URL`, `SUPABASE` or `POSTGRES` is named in the plan as a warning. Proof: `2: the test command environment holds no variable that names another database or project`, `D: the test command environment` (unit) and `removes other database variables and points DATABASE_URL and PG* at the copy`, `2: the plan names what was removed from the test environment, and the .env files it cannot control` (matrix).
- **`--admin-url` must be the server that holds the source.** The tool compares the cluster system identifier, or the server address, port and data directory, and refuses a different server with exit 2 before anything is created. Proof: `C: same server` (unit) and `C: --admin-url must be the same server as --db-url` (matrix, which starts a second throwaway server).
- **It never closes your connections without a separate yes, and only on a server it has proven is yours.** Closing other sessions needs its own approval: the question, or `--close-sessions`. `--yes` does not give it. It is never done on a remote host, with `--no-terminate`, or with the remote flag. It is also refused when `--admin-url` can be tied to the source only by host and port; the system identifier or the data directory must match. The closing statement is bound to the name of your database. Proof: `B: closing sessions needs its own approval`, `H3: a busy source that may not be closed is rejected without any DDL`, `4: closing sessions only on the source database, and never once denied` (unit) and `--yes alone does not close other sessions; --close-sessions does`, `no-terminate-with-remote-flag: the remote flag never closes a session` (matrix).
- **It does not copy a large database by surprise.** A source over 2 GB is refused with exit 2 unless you pass `--max-size <size>`. Copying locks the source for the length of the copy and needs about (jobs + 1) x its size in free disk. The plan shows the server version, the size, the other sessions and the address the server reports, not only the host name you typed. Proof: `a source above --max-size is refused, with exit 2, before any copy` and `the plan lists server version, source size, other sessions and the server address` (matrix).
- **Outbound HTTP from a copy is switched off** unless you pass `--no-isolate-network`. In the copies, never in your database, every function of schema `net` and of the `pg_net` and `http` extensions keeps its signature and does nothing, so triggers and database webhooks cannot call out. Proof: `E: outbound HTTP from the copy is switched off` (matrix).
- **Names from the database are never printed raw.** Control characters, escape sequences, bidirectional overrides, line and paragraph separators and zero-width characters in policy, table, role and function names, expressions and test output are written out visibly (`\x1b`) in the console and the Markdown report. Proof: `G: visible()` (unit) and `an escape sequence in a policy name never reaches the console or the report as a control character` (matrix).
- **A bad value is never a default.** `--threshold` outside 0 to 100, `--jobs` below 1 or not whole, a bad `--timeout`, `--max-size` or `--runner` exit 2. A run in which no break was decided (none run, all skipped, all errored) exits 2, not 0. Proof: `H1: option values`, `H1: a run that decided nothing is not a pass`, `6: --runner is checked` (unit) and `H1: values are checked, and a run that checked nothing is not a pass` (matrix).
- **A crash cannot leave your database changed.** There is nothing to undo. Proof: `crash-during-first-copy: kill -9 mid-copy leaves the source open and unchanged` (matrix).
- **It never runs without asking, unless you say `--yes`.** Proof: `confirmation steps` (test/confirm.test.ts), `run asks before it copies anything` (test/run-confirm.test.ts) and `no-prompt-without-yes: a run with no terminal and no --yes exits 2 and makes no copy` (matrix).

What a copy can still do, and what this does not cover:

- **Test files run with your database user's rights.** The pgTAP files (`supabase test db` or `--runner psql`) are your code. They run as the user in `--db-url` on the same server as your database. A `\c otherdb` or a `dblink` call inside a test file can reach other databases on that server, with that user's rights. The tool cannot prevent this without a separate role. The plan says so. Read your test files before you run them.
- A copy holds a full copy of your data and runs your SQL. Any function in it runs as it would in your database. Outbound HTTP is off by default; with `--no-isolate-network` it is on. Connections opened by `dblink`, `postgres_fdw`, `plpython3u`, `plperlu`, `pltclu` or `file_fdw` are **not** switched off; the report lists these extensions in a note when the database has them.
- The test command you give it (`--test`, or the `test` value in `.rls-saboteur.json`) is your code and runs as you. Its environment holds no variable that names another database, but it is a shell command: it can read files such as `~/.pgpass`, `pg_service.conf` or a `.env` file, and open any network connection. The tool shows a command from the config file to you before it runs.
- "Local" is decided from the host name in the URL. An SSH tunnel or a cloud proxy on `127.0.0.1` looks local. That is why the plan prints what the server itself reports, and why a source over 2 GB needs `--max-size`.

Versions before 0.2.0 had an `--isolation in-place` mode that edited your real database. It was removed in 0.2.0.

### Confirmation steps

Before anything is copied, the tool prints a plan and waits for you:

```
Plan
  Database: postgres on 127.0.0.1 (local; that is the host name only, the lines below come from the server)
  Server: PostgreSQL 17.6. Server reports address 172.18.0.2 port 5432.
  Size of "postgres": 8329 kB
  Other sessions: 0
  Note: outbound HTTP from the copy is switched off.
  It will: make temporary copies of it, break 42 policies in the copies, run: supabase/tests/*.sql  (pgTAP, run with supabase test db)
  It will not change this database.
Continue? (y/N)
```

The default is No. An empty answer is No.

1. **The plan.** As above.
2. **Closing other sessions.** If the first copy needs it (local databases only): `N other connection(s) are open to <db> (<application names>). Close them for a moment? They reconnect by themselves. (y/N)`. No stops the run with the explanation. **`--yes` does not answer this question.** With no terminal, pass `--close-sessions` for it, or the run exits 2 and names the flag.
3. **A test command from `.rls-saboteur.json`.** The exact command is shown and you are asked before it runs. A command passed with `--test` on the command line is not asked about, because you typed it.

With no terminal (stdin or stdout is not a TTY, or `CI=true`) the tool never prompts and never waits. Without `--yes` it exits 2 and names `--yes`. `--yes` approves the plan and a test command from the config file, so pass it only for a run whose plan you have read. It does not approve closing sessions: that needs `--close-sessions`. The GitHub Action passes `--yes`, because the workflow is your own. It passes `--close-sessions` only when it started the throwaway Supabase stack itself (`start-supabase: true`), unless you set `close-sessions` yourself.

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

RLS Saboteur handles this once, at the start, on a local database only, and only after you answer yes. With your separate yes (the question, or `--close-sessions`; `--yes` is not enough) it closes the other connections for about a second, makes the master template, and lets them reconnect. It prints a note when it did so. It changes no setting of your database to do this. With `--no-terminate`, with the remote flag, or on a remote host it never closes anything: a busy database is an error that tells you how to free it.

A stock local Supabase stack has one more catch. The cron scheduler keeps a connection open as a superuser, and the normal `postgres` role cannot close it. So when the host is local and `supabase/config.toml` exists, RLS Saboteur tries the CLI's documented local superuser (`supabase_admin`, local default password) on the same host and port. It uses that role only to copy and drop databases, and prints one line saying so. If that login fails, pass your own with `--admin-url <superuser url>`.

If no copy can be made, it stops with exit 2 and your database is untouched. Pass `--admin-url` with a superuser URL, or stop the services that use the database.

### Security notes

- **`--test` and the `test` value in `.rls-saboteur.json` run as shell commands**, the same way `package.json` scripts do. Run the tool only in projects you trust, and never with a config file you did not read.
- **In CI, never pass untrusted text to the Action's `extra-args` input.** It becomes command-line options. Pull request titles, branch names and comment bodies are untrusted. The same goes for the `test` input.
- **Give the workflow the least permission.** Set `permissions: contents: read` on any workflow that uses the Action.
- Passwords are passed to `psql` and the Supabase CLI in `PGPASSWORD`, not on the command line.
- The Action checks its inputs before it runs anything: `version` must look like `0.2.0`, `threshold` must be 0 to 100, `jobs` a whole number of 1 or more, `close-sessions` empty, `true` or `false`.

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
--runner <name>       auto, supabase or psql (anything else exits 2)
--jobs <n>            Breaks run in parallel on copies. Default: 2
--threshold <pct>     Fail below this score. Default: 100
--only-related        Per break, run only the test files that mention the table
--isolation template  Accepted for old scripts. `in-place` was removed in 0.2.0.
--admin-url <url>     Superuser URL used only to copy and drop databases
--tests-dir <dir>     Directory of pgTAP files. Default: supabase/tests
--no-terminate        Never close other connections for the first copy
--yes                 Approve the plan and a config-file test command without asking (needed without a terminal). Does not approve closing sessions.
--close-sessions      Approve closing other sessions on a local source for a moment, to take the first copy. Needs its own flag.
--max-size <size>     Allow a source larger than 2GB (default limit 2GB), for example --max-size 5GB
--no-isolate-network  Leave outbound HTTP on inside the copies (default: switched off)
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
- It never changes your database. It reads the catalogue, and your rows are copied into temporary databases on the same server, which are dropped afterwards. It runs your own tests on the copies.
- Copies are named `saboteur_<host id>_<pid>_<run token>_<n>`, labelled, and dropped after each break. A run that dies leaves none behind that the next run does not sweep. A copy is swept only if its name or label says it was made by this host and its process is dead. See "What it will never do".
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

The Action passes `--close-sessions` by default only when `start-supabase` is `true` (the default), because the database is then a throwaway stack that the Action started itself. With `start-supabase: false` the database is yours, so the default is no. Set `close-sessions: true` or `false` to override either way.

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
