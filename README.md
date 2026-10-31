# RLS Saboteur

[![npm version](https://img.shields.io/npm/v/rls-saboteur)](https://www.npmjs.com/package/rls-saboteur)
[![CI](https://github.com/mattmuller/rls-saboteur/actions/workflows/ci.yml/badge.svg)](https://github.com/mattmuller/rls-saboteur/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/npm/l/rls-saboteur)](LICENSE)

## For AI agents

- **Plugin and skill.** `plugin/` is a Claude Code plugin. `plugin/skills/rls-saboteur/SKILL.md` teaches an agent the whole loop: run the tool, read the missed breaks, write a pgTAP test for each one, and run again. The `/sabotage` command starts it. Install it with `/plugin marketplace add mattmuller/rls-saboteur`.
- **Exit codes.** `0` passed, `1` below the threshold or a check failed, `2` could not check.
- **JSON.** Add `--json` to get one JSON object on stdout. The console report goes to stderr. `--json-file <path>` writes the same JSON to a file.
- **No terminal.** An agent has no terminal to answer the plan question, so it must pass `--yes`. Pass it only for a run whose plan you have read. Closing other sessions on the database needs `--close-sessions`; `--yes` does not give it.
- **HOL Guard.** If your agent runs under [HOL Guard](https://github.com/hashgraph-online/hol-guard), its `command.rls-saboteur` extension asks before an agent runs RLS Saboteur with a risky option. See [HOL Guard](#hol-guard).
- **Rules for working on this repository** are in [AGENTS.md](AGENTS.md).

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
- **Every connection and every test runner is started on the database it names, and no other.** This is about where the URL and the environment send a connection. What a test file does once it is connected is a different matter: see "What a copy can still do". A `--db-url` or `--admin-url` with a connection parameter in its query string (`dbname`, `host`, `options`, `user`, `port`, `service` and the like) is refused with exit 2, because psql and the Supabase CLI let those override the URL. Every copy URL is built from parsed parts. Every connection checks `current_database()`, and a test runner is started with the copy in `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` and a URL without a query string. Proof: `A: connection URLs`, `A: every connection must land on the database it names` (unit) and, against real psql, `the psql runner installs pgTAP only in the database named by the path, never in ?dbname=` and `the CLI refuses ?dbname= on --db-url with exit 2 and creates nothing` (matrix; vitest prints `dbname` in place of `%s`).
- **A test command sees no variable that names another database.** The tool removes every environment variable whose name contains `DATABASE`, `DB_URL`, `DBURL`, `DB_CONNECTION`, `DIRECT_URL`, `POSTGRES`, `SUPABASE` or `SERVICE_ROLE` (any case), and every `PG*` variable. Then it sets `DATABASE_URL`, `SABOTEUR_DB_URL` and `PG*` to the copy. The plan lists the removed names, never the values. **Files your test framework loads itself are not controlled.** A `.env`, `.env.local`, `.env.test` or `.env.test.local` in the working directory that mentions `DATABASE_URL`, `SUPABASE` or `POSTGRES` is named in the plan as a warning. Proof: `2: the test command environment holds no variable that names another database or project`, `D: the test command environment` (unit) and `removes other database variables and points DATABASE_URL and PG* at the copy`, `2: the plan names what was removed from the test environment, and the .env files it cannot control` (matrix).
- **`--admin-url` must be the server that holds the source.** The tool compares the cluster system identifier, or the server address, port and data directory, and refuses a different server with exit 2 before anything is created. Proof: `C: same server` (unit) and `C: --admin-url must be the same server as --db-url` (matrix, which starts a second throwaway server).
- **It never closes your connections without a separate yes, and only on a server it has proven is yours.** Closing other sessions needs its own approval: the question, or `--close-sessions`. `--yes` does not give it. It is never done on a remote host, with `--no-terminate`, or with the remote flag. It is also refused when `--admin-url` can be tied to the source only by host and port; the system identifier or the data directory must match. The closing statement is bound to the name of your database. Proof: `B: closing sessions needs its own approval`, `H3: a busy source that may not be closed is rejected without any DDL`, `4: closing sessions only on the source database, and never once denied` (unit) and `--yes alone does not close other sessions; --close-sessions does`, `no-terminate-with-remote-flag: the remote flag never closes a session` (matrix).
- **It does not copy a large database by surprise.** A source over 2 GB is refused with exit 2 unless you pass `--max-size <size>`. Copying locks the source for the length of the copy and needs about (jobs + 1) x its size in free disk. The plan shows the server version, the size, the other sessions and the address the server reports, not only the host name you typed. Proof: `a source above --max-size is refused, with exit 2, before any copy` and `the plan lists server version, source size, other sessions and the server address` (matrix).
- **Outbound HTTP from a copy is switched off** unless you pass `--no-isolate-network`. In the copies, never in your database, every function of schema `net` and of the `pg_net` and `http` extensions keeps its signature and does nothing, so triggers and database webhooks cannot call out. Proof: `E: outbound HTTP from the copy is switched off` (matrix).
- **Names from the database are never printed raw.** Control characters, escape sequences, bidirectional overrides, line and paragraph separators and zero-width characters in policy, table, role and function names, expressions and test output are written out visibly (`\x1b`) in the console and the Markdown report. Proof: `G: visible()` (unit) and `an escape sequence in a policy name never reaches the console or the report as a control character` (matrix).
- **A bad value is never a default.** `--threshold` outside 0 to 100, `--jobs` below 1 or not whole, a bad `--timeout`, `--max-size` or `--runner` exit 2. A run in which no break was decided (none run, all skipped, all errored) exits 2, not 0. Proof: `H1: option values`, `H1: a run that decided nothing is not a pass`, `6: --runner is checked` (unit) and `H1: values are checked, and a run that checked nothing is not a pass` (matrix).
- **A new mode needs the same guarantees.** The empty master that `--from-files` and `--sandbox` use is allowed in build mode only, for the master only, and never from anything but `template0`. Proof: `empty-master: the guard refuses a master made from template0 unless build mode is on` and `empty-master: build mode allows template0 for the master only, and no other template` (unit).
- **Every `docker` command is on an allowlist.** One container shape, no privilege, no mount, no host network, a loopback port; `exec` runs only `pg_dump`, `psql` and `pg_isready`; every other verb is refused. Proof: `docker guard: allows the one container shape the tool starts`, `docker guard: refuses privileges, mounts, host network and a published port beyond loopback`, `docker guard: exec runs only pg_dump, psql and pg_isready in its own container`, `docker guard: refuses every other verb, and a removal of a name that is not the tool's` (unit).
- **Only the tool's own containers are removed.** Proof: `removableContainer (the one rule behind every container removal)` (unit) and, in the matrix, `sandbox-sweep: the next run removes the container of a dead process, and no other`.
- **A sandbox container does not outlive the run.** Proof, in the matrix: `sandbox-files: the copies are built in a container from the files, and the container and its volume are gone afterwards`, `sandbox-kill9: a run killed with SIGKILL leaves no container behind`, `sandbox-sigint: SIGINT removes the container and exits 130` and `sandbox-sigterm: SIGTERM removes the container and exits 143`.
- **`--from-files` runs only in a sandbox.** Proof: `files-need-sandbox: --from-files without --sandbox exits 2 and creates nothing` (matrix).
- **No real row reaches a copy built from files.** Proof: `sandbox-files` (a source with marked rows; the copies show only the seed rows).
- **Outbound HTTP is switched off after the build and after every file.** Proof: `sandbox-net: a migration that creates net.http_post is neutralised, and the seed cannot call it` (matrix).
- **The dump session is read-only and fires no trigger.** Proof: `sandbox-dump-readonly: the dump session asks the server to refuse writes, and names the container host` (unit) and `sandbox-dump: the rows are streamed into the container, masked there, and the source is unchanged` (matrix, which compares the source before and after).
- **A `--from-files` container has no network.** Proof: `sandbox-isolated: in --from-files mode a migration cannot reach the host or the internet, and no port is published` (matrix) and `docker guard: the files shape has no network at all, and nothing else is accepted in its place` (unit).
- **Masking reaches every table below the masked one.** Proof: `mask-inherit: rows, statistics and files of inheritance children and partitions are cleaned too` (matrix), and `mask-inherit: every table below the masked one is vacuumed and has its statistics checked`, `mask-inherit: an original value in the statistics of a child stops the run` and `mask-inherit: a foreign table below the masked one stops the run before anything is rewritten` (unit), and `mask-child-refused: masking a child table on its own exits 2 before anything is copied` (matrix) and `mask-inherit: a table that has a parent cannot be masked on its own, and the plan check says so` (unit).
- **Role names cannot change the role script.** Names with `$`, a backslash or a line break are refused, and the script tag is random per run. Proof: `sandbox-role-names: a name with $, a backslash or a line break is refused, and the tag changes every time` (unit).
- **Masking fails closed, and the database confirms it.** Proof: `mask-closed: a column that does not exist stops the run`, `mask-closed: a row that was not rewritten stops the run and rolls back`, `mask-closed: an original value that survives stops the run and rolls back`, `mask-closed: a role that cannot switch triggers off stops the run`, `mask-closed: a type scramble cannot handle, a view and a generated column stop the run`, `mask-stats: an original value still in the planner statistics stops the run` (unit); `mask-db: every masked value is different in the database afterwards, and the shape survives` (matrix; it reads the table, `pg_stats`, `pg_stats_ext` and the data files before and after), `mask-run: the first copy is masked before the baseline, and the same value masks the same way in two tables`, `mask-missing-column: a named column that does not exist exits 2 before anything is copied or run` and `mask-failure: a rewrite that fails after the copy exists stops the run before any test and removes the copy` (matrix).
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
  Test environment: no variable that names a database or Supabase project was set; DATABASE_URL, SABOTEUR_DB_URL and PG* point at the copy.
  Note: the test files are your code. They run with the rights of your database user on this server, so a \c or dblink inside one can reach other databases there.
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

## Sandbox, schema and seed only, and masking

Three options change where the copies live and what they hold. None of them changes the default. Without these flags, the tool sends the same statements as 0.2.1.

| You want | Pass |
|---|---|
| No copy on the server that holds your database | `--sandbox` |
| No real row read at all | `--sandbox --from-files` |
| Chosen columns scrambled in the first copy | `--mask schema.table.column` (repeat it) |

The three combine. `--from-files` always needs `--sandbox`.

### Sandbox: `--sandbox`

The copies live in a throwaway PostgreSQL container, not on the server that holds your database. The tool starts the container, builds the master template in it, makes every break copy in it, runs your tests against it and removes it. It needs a running Docker.

```sh
npx rls-saboteur --sandbox
npx rls-saboteur --sandbox --sandbox-image public.ecr.aws/supabase/postgres:17.6.1.011
```

- **What it changes.** Nothing is created on your server, nothing there is locked, and no session on it is ever closed. A busy local Supabase needs no `--close-sessions` and no `--admin-url`. A source over 2 GB still needs `--max-size` when rows are streamed in.
- **What it does not change.** The copies still hold files. The container's storage is deleted with the container. On Linux that storage is on the same machine as Docker, so "no copy on your machine" is true of your database server, not of the disk. On Docker Desktop it is inside the Docker VM.
- **How the rows get in.** Without `--from-files`, the tool runs `pg_dump` inside the container, against your database, in a session that the server holds read-only (`PGOPTIONS=-c default_transaction_read_only=on`), and loads the result with `psql`. Roles are created first from `pg_roles` (no superuser, no password). `pg_dump` creates triggers after it loads the data, so no trigger fires during the load. The rows pass through the Docker client as a stream and are not stored outside the container.
- **The image.** The default is `postgres:<major version of your database>` from Docker Hub, pulled if it is not here. That image has no pgTAP and none of the Supabase roles or extensions. Pass `--sandbox-image` for an image that does. A Supabase source loaded by dump into a Supabase image fails, because the image already holds the managed schemas. For Supabase, use `--from-files`.
- **`--sandbox-image` runs an image you name.** Treat it like any command you run.
- **Reaching your database from the container.** The container reaches a source on `127.0.0.1` through `host.docker.internal`. That works on Docker Desktop. On Docker Engine for Linux, a source that listens on `127.0.0.1` only may not be reachable from a container; the Docker documentation does not promise it, and this release did not test it. A source published on `0.0.0.0` works.
- **Safety.** There are two container shapes. With a dump, the container sits on the default Docker network and publishes one port on `127.0.0.1` only. With `--from-files`, it has no network at all (`--network none`) and no published port (see below). Either way: a random password, no mount, no privilege, no host network. Every `docker` call goes through one allowlist (`src/docker.ts`), like the database guard. It starts those two shapes, runs only `pg_dump`, `psql`, `pg_isready` and one fixed relay script inside the container, and removes only containers that carry the tool's name and labels and belong to this run, or to a dead process of this host.
- **A password is always needed.** The container starts with `POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256` and a random password. After it is ready, the tool connects with a WRONG password through the same path your tests use and stops the run if the server lets it in (an image whose `pg_hba.conf` trusts loopback would do that). Proof: `sandbox-auth-relay: a wrong password through the relay is refused, and the right one is accepted` and `sandbox-auth-trust: an image that trusts loopback stops the run with exit 2 and leaves no container` (matrix), and `sandbox-auth: a server that lets a wrong password in stops the run, one that refuses it passes` (unit).
- **What the container can reach.** With a dump, the container can reach your machine and the internet, because `pg_dump` runs in it and must reach your database. Nothing of yours runs there except the SQL restored from your own database, with the triggers created after the data, so none fires. With `--from-files`, it has no route to your machine or the internet. See "Schema and seed only".
- **A run that dies.** Ctrl-C and SIGTERM remove the container before the tool exits (130 and 143). After `kill -9`, a detached watchdog removes the container within a few seconds. The next run also removes any container of this host whose process is dead, and never one of a live process or another host. If a removal fails, the tool prints `docker rm -f -v <name>`.

### Schema and seed only: `--from-files`

Each copy is built from your files instead of cloning your database. The tool reads `supabase/migrations/*.sql` in name order, then `supabase/seed.sql`. No row of your database is read. Pass `--migrations-dir` and `--seed-file` for other places. A missing default seed file means empty tables.

```sh
npx rls-saboteur --sandbox --from-files
```

- **It needs `--sandbox`.** Migration and seed files are your code. On your own server they would run with the rights of your database user and could change roles or other databases there. In the container they can only reach the container (see below). Without `--sandbox` the run exits 2. A restricted role on your own server was considered and not built, because this release did not prove one sound.
- **What the files can reach.** With `--from-files`, the container runs with `docker run --network none`. It has no route at all and no IPv4 address except loopback (Linux still lists a few fallback tunnel devices in a new network namespace, all down and without an address), no `host.docker.internal` name, no route to your machine, the Docker bridge gateway, other containers or the internet, and it publishes no port. This tool reaches its Postgres through `docker exec`: a relay on `127.0.0.1` on your side carries each connection into the container. An internal Docker network was tried first. It was not used: Docker ignores a published port on it, and this release did not prove that it blocks the container's own bridge gateway, which `--network none` does by having no route. Proof: `sandbox-isolated: in --from-files mode a migration cannot reach the host or the internet, and no port is published` runs a migration that tries a TCP connection to the host name, to the Docker bridge gateway, to loopback on the host's Postgres port and to `1.1.1.1`, from inside the container with `COPY ... FROM PROGRAM`. All four are blocked, the routing table is empty, and the only IPv4 addresses are `127.x`. The same test checks `NetworkMode` is `none`, there are no port bindings and no extra host entry, and that the same probe on the default network does connect (so the test can fail). This was tested on Docker Desktop for Mac only. `--network none` is a Docker feature, but this release did not run the probe on Linux Engine.
- **What the files can still do.** They run as the superuser of the container's Postgres, so they can run programs as the container's `postgres` user, read the container's files and use the container's CPU, memory and disk. They cannot reach anything outside it. Outbound HTTP functions (`net`, `pg_net`, `http`) are also switched off after every file, as a second layer.
- **Tested runners.** The `psql` runner and `--test` commands, on Docker Desktop for Mac. The Supabase CLI runner (`supabase test db`) connects to the relay on `127.0.0.1`; this release did not test it. Linux Engine was not tested.
- **The policies must match.** Breaks are generated from the policies of your database. After the build, the tool compares the policies of the copy with the policies of your database. If any differ, the run exits 2 and names them, before any test runs.
- **Your database is still read for its catalogue**, as before: policies, tables, columns and roles. No user table is selected from.
- **Roles.** The files must create the roles they use, or the image must have them (a Supabase image does). A role the files do not create stops the build with the server's message.

### Masking: `--mask`

```sh
npx rls-saboteur --sandbox --mask public.users.email --mask public.users.full_name --mask public.users.notes=null
```

Or in `.rls-saboteur.json`: `"mask": ["public.users.email", "public.users.notes=null"]`.

The columns are rewritten in the first copy (the master template), after it is built and before pgTAP, the baseline run or any break. Every later copy inherits them.

- **Scramble** (the default) replaces a value with a hash of it and a random salt made for the run. The same input gives the same output in the whole run, so a masked e-mail on `orders` still matches the masked e-mail on `users` when you mask both. `NULL` stays `NULL`. Unique constraints and `varchar(n)` limits hold. It handles `text`, `varchar`, `char`, `citext`, `name`, `uuid`, `smallint`, `integer` and `bigint`. `=null` sets the column to `NULL` and works for every type of column that accepts `NULL`.
- **It fails closed.** The run stops, with exit 2 and no test run, when: a named column does not exist (checked against your database before anything is copied, and again on the copy), a name is not a plain table column (a view or a generated column), the type cannot be scrambled, the rewrite raises an error, a row was not rewritten, an original value is still in the column, or an original value is still in the planner statistics. The role must be able to switch triggers off (`session_replication_role = replica`), which needs a superuser. Row security is off for the rewrite, so a policy cannot hide a row from it.
- **Old values are removed from the files.** After each column, the tool runs `VACUUM FULL` and `ANALYZE` on the table and on every inheritance child and partition (found through `pg_inherits`), and `VACUUM FULL` on `pg_statistic` and `pg_statistic_ext_data`, so dead rows, index pages and `pg_statistic` no longer hold the originals, and then asks `pg_stats`, `pg_stats_ext` and `pg_stats_ext_exprs` whether any original value is left.
- **What masking does not cover.**
  - Only the named columns, and the tables below them. Inheritance children and partitions of a masked table are rewritten by the same `UPDATE`, so the tool vacuums each of them and checks the statistics of each. A foreign table below it stops the run, because the `UPDATE` would go to its server. A table that has a parent cannot be masked on its own, because the parent's statistics also hold its values: mask the root table, whose rewrite reaches every table below it. The run exits 2 before anything is copied. A copy of a value in another column, an audit table, a JSON column or a function default stays as it was. Name those columns too.
  - Triggers are switched off during the rewrite, so an audit trigger cannot copy the old value. That also switches off foreign key actions. If you mask a column that other tables reference and do not mask them too, the references no longer match. Mask both sides.
  - The server that made the copy, and its write-ahead log and logs, may still hold the original values. In sandbox mode that server is the container, which is removed. In the default mode it is your own server.
  - With `--sandbox` and no `--from-files`, real rows reach the container before they are masked. Use `--from-files` if no real row may be read.
  - The tests run on masked data. A test that depends on a real value fails the baseline, and the run exits 2.
  - Masking low-cardinality columns (a flag, a small number) can fail the check that no original value is left, because a scrambled value can equal an old one. Mask identifying text.

### pg_cron

Scheduled `pg_cron` jobs do not run in a copy. This was tested on a real server, not assumed. Tests: `pg-cron-copies: a job scheduled in the source keeps running there and never runs in a copy` (the matrix, PostgreSQL 16 and 17, with `pg_cron` preloaded) and the manual run below.

- The `pg_cron` scheduler reads `cron.job` only in the database named by `cron.database_name` (default `postgres`). A copy has a different name, so its `cron.job` rows are copied and inert. A job registered inside a copy never runs either.
- A job fires in a copy only if a job in the cron database names that copy in its `database` column. Copy names are random for every run, so no existing job can name one. (Shown by scheduling such a job on purpose: it did fire. That needs a job written against the copy's name, which the tool never publishes.)
- Jobs registered in your database keep running there, as they did before. The tool is read-only on it and does not pause them.
- The scheduler keeps a connection to the cron database open. That is why the first copy of a stock local Supabase needs `--close-sessions` (see "The first copy and open connections").
- **A build mode cannot create `pg_cron`.** `create extension pg_cron` is accepted only in the cron database, so it fails in the fresh database of a copy built from files or a dump. The run exits 2 and says so. Use the default mode (a clone keeps the extension and its inert jobs) or keep `pg_cron` out of the files.

## Ideas

Planned, in no fixed order. Ideas and pull requests are welcome.

- **A restricted role for `--from-files`**, so the files could run on your own server without a container.
- **Block the container's network during the build**, so even a file that installs the extension and calls out in the same file is stopped.
- **Windows.**

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
--sandbox             Run the copies in a throwaway Docker container instead of on your database server
--sandbox-image <i>   Image for --sandbox. Default: postgres:<major version of your database>
--from-files          With --sandbox: build the copies from supabase/migrations and supabase/seed.sql, so no real row is read
--migrations-dir <d>  With --from-files: the migrations directory (default supabase/migrations)
--seed-file <path>    With --from-files: the seed file (default supabase/seed.sql)
--mask <col>          Scramble schema.table.column in the first copy (repeat it); col=null sets it to NULL. The run stops if it cannot.
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
- By default, copies hold the same rows as the source and nothing is masked, so point it at a database with seed or test data, which is what the default (your local Supabase) normally holds. To keep real rows out of the copies, use `--from-files` or `--mask` (see "Sandbox, schema and seed only, and masking").

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

`npm run test:matrix` runs six synthetic databases end to end, on PostgreSQL 16 and 17 (official `postgres` images plus pgTAP and pg_cron). A seventh file, `test/matrix/modes.test.ts`, runs the sandbox, schema-and-seed, masking and pg_cron tests. Each fixture has its own tests and an `expected.json` that lists every break that must be caught and every break that must be missed. CI runs the same matrix.

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

## HOL Guard

[HOL Guard](https://github.com/hashgraph-online/hol-guard) reviews the commands an AI agent runs before they run. It ships an extension for RLS Saboteur, [`command.rls-saboteur`](https://github.com/hashgraph-online/hol-guard/blob/main/contributions/extensions/command.rls-saboteur.json), added in [hol-guard#4636](https://github.com/hashgraph-online/hol-guard/pull/4636). It has four permissions:

| Permission | Tier | It covers |
|---|---|---|
| `copy-run` | medium | any run, because a run copies your database |
| `remote-override` | high | `--allow-remote-i-understand-this-locks-tables` |
| `close-sessions` | high | `--close-sessions` |
| `no-isolate-network` | medium | `--no-isolate-network`, which turns off network isolation in the copies |

Turn a permission off and Guard blocks that kind of run instead of asking. It recognises `rls-saboteur` run directly and through npx, npm, pnpm, yarn and bun, with or without a version. One limit: after npm's own `--` on a versioned launch (`npm exec rls-saboteur@x -- ...`), a flag is matched only when it comes first or right after `--yes`; in any other position that run is still reviewed as a `copy-run`.

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
npm run test:matrix # needs Docker; starts and removes rls-saboteur-ci-16, -17, -b-* and -cron-* (and the sandbox containers its tests start)
```

MIT. Copyright Matt Muller.
