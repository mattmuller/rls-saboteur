# Plain Postgres (no Supabase)

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
