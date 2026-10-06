# RLS Saboteur

Your Supabase RLS tests pass. This tool checks whether they would fail if a policy broke.

It breaks each row level security policy on purpose, one at a time, and runs your tests. Every break the tests did not notice is listed as **missed**. A missed break is a real hole: a policy that could go wrong with no test to say so.

This is mutation testing for Postgres policies. Stryker and PIT do it for application code. Tools like rlsautotest and SupaShield write RLS tests. RLS Saboteur checks the tests, whoever wrote them.

```sh
supabase start
npx rls-saboteur
```

No configuration. It reads the database port from `supabase/config.toml`, every policy from the Postgres catalogue, and your pgTAP files from `supabase/tests`.

## Before and after

The `examples/demo` project is a small multi-tenant app (orgs, members, documents, invoices) with a pgTAP suite that looks complete and passes.

**Before.** The suite in `examples/demo/supabase/tests`:

```
@@BEFORE@@
```

**After.** The same project with the tests in `examples/demo/fixed/tests`, which add one test for each miss:

```
@@AFTER@@
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
2. **Baseline.** It runs the tests unchanged. If they fail, it stops and says so.
3. **Copy.** It copies the database once into a master template. Then, for each break, it makes a throwaway database with `CREATE DATABASE ... TEMPLATE`, applies the break with DDL, runs the tests against that copy, and drops it. Your database is not changed.
4. **Report.** Caught means the tests failed. Missed means they passed.

### How tests are pointed at a copy

- Default runner: `supabase test db --db-url <copy url>`. The Supabase CLI takes a connection string, so it runs the same pgTAP suite against the copy.
- No Supabase CLI: `--runner psql` runs each `.sql` file with psql against the copy. It installs pgTAP in the copy. A file fails on a non-zero exit, a `not ok` line, or a plan mismatch.
- Any other command: `--test "pnpm test:rls"`. The copy is passed as `$DATABASE_URL`, `$SABOTEUR_DB_URL`, the `PG*` variables, and as `{{db_url}}` inside the command string. The command must exit non-zero on failure.

### The first copy and open connections

Postgres refuses to copy a database while anyone else is connected to it. A running local Supabase always has connections open (auth, REST, realtime), so a direct copy fails with "source database is being accessed by other users".

RLS Saboteur handles this once, at the start. It closes the other connections for about a second, makes the master template, and lets them reconnect. It prints a note when it did so. If your role cannot close them, or you pass `--no-terminate`, it falls back to **in-place mode**: it applies each break to your local database, runs the tests, and puts the policy back, one break at a time. In-place mode restores on Ctrl-C too.

The demo stack runs only the database, so there is nothing to disconnect there.

## Checks that need no tests

These run on every invocation, and alone with `--checks-only`. They read the catalogue and call nothing.

| Check | What goes wrong |
|---|---|
| A policy calls a function its role cannot EXECUTE | Every query on the table fails for that role. A grep of the code cannot see it, because the caller is a policy. |
| A custom role is a member of anon or authenticated | The role inherits everything, and every restriction on it stops meaning anything. |
| A column-level grant under a table-level grant | Column privileges add to table privileges. The column grant or REVOKE changes nothing. |
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
--isolation <mode>    auto, template or in-place
--no-terminate        Do not close other connections for the first copy
--filter <text>       Only breaks whose id contains this text
--checks-only         Only the checks that need no tests
--dry-run             List the breaks and stop
--json                JSON report on stdout
--json-file <path>    Write the JSON report to a file
--report <path>       Markdown report. Default: saboteur-report.md
```

Exit codes: `0` passed, `1` below the threshold or a check failed, `2` could not check (tests fail unchanged, no tests, refused database, no connection).

The score is caught divided by caught plus missed. Breaks that could not be applied, timed out, or were skipped by config are listed in the report and not counted.

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
- Copies are named `saboteur_<pid>_<n>` and dropped after each break. A run that dies leaves none behind that the next run does not sweep.
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

### Security

- The action installs `rls-saboteur` from npm with `npx` and runs your tests with the Supabase CLI. It runs nothing else.
- Inputs are never interpolated into scripts. Each one is passed through an environment variable and quoted, so a crafted input cannot inject a command.
- `version` defaults to the version the action release ships with, and `supabase/setup-cli` is pinned. Pin the action itself to a tag or a commit.
- The release step must keep the `version` default in `action.yml` equal to `package.json`.

## Related tools

[rlsautotest](https://github.com/search?q=rlsautotest) and [SupaShield](https://github.com/search?q=SupaShield) generate RLS tests. Run RLS Saboteur on the result. Supabase's own `splinter` lints settings; it does not run your tests.

## Develop

```sh
npm install
npm test            # unit tests
npm run build
npm run test:e2e    # needs a local Postgres; set SABOTEUR_E2E_URL
```

MIT. Copyright Matt Muller.
