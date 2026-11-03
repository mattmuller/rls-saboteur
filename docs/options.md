# Options

## Local Supabase: the admin URL

Against a local Supabase stack, you may need `--admin-url postgres://supabase_admin:postgres@127.0.0.1:<port>/postgres`. Without it, the copy step can fail with "postgres still has connections that this role cannot close". Use the database port from `supabase status`.

## All options

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
--sandbox-host-network  With --sandbox and a dump: allow pg_dump on the host network when the container cannot reach a database
                        on 127.0.0.1 (Docker Engine for Linux). Automatic for the default image only.
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

## Optional config

A `.rls-saboteur.json` in the project root:

```json
{
  "schemas": ["public"],
  "threshold": 95,
  "skip": [{ "policy": "public read of the status page", "reason": "Equivalent to the original: the table is public on purpose." }]
}
```

Every skip needs a written reason, and skipped breaks are listed in the report.
