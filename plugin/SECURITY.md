# Security

Report a security problem privately, not in a public issue:
https://github.com/mattmuller/rls-saboteur/security/advisories/new

Please include what you ran, what happened, and the version (`rls-saboteur --version` or the package version).

## What this tool does to your system

- It refuses any database that is not local unless you pass `--allow-remote-i-understand-this-locks-tables`.
- It never changes your database. It reads the catalogue, and your rows are copied into temporary databases on
  the same server (`CREATE DATABASE ... TEMPLATE`), which are dropped afterwards. It runs your own tests on the copies.
- A source over 2 GB is refused unless you pass `--max-size`. Copying locks the source for the length of the copy
  and needs about (jobs + 1) x its size in free disk. The plan prints the version, size, other sessions and address
  that the server itself reports, because "local" is decided from the host name only and an SSH tunnel on
  `127.0.0.1` looks local.
- For each break it creates a temporary copy of the database (`saboteur_<host id>_<pid>_<run token>_<n>`), changes
  one policy inside that copy, runs your tests against it, then drops the copy.
- It never changes the database you point it at, and never changes a setting of it. Every connection to it is
  opened read-only and only plain `SELECT` reads are allowed through. The guard (src/guard.ts) is an allowlist of
  the statements the tool itself sends; it does not inspect your test files or test command. There is no in-place
  mode: it was removed in 0.2.0 because it changed the real database.
- The identity of a copy is in its name (host id, pid, run token) and in its label (`COMMENT ON DATABASE ...
  'rls-saboteur copy <token> host=<host id>'`). It drops only databases that are not yours and that were made by
  this run, or by a process of this host that has died. A copy from another host or a live process is never swept.
  A `--db-url` whose database name looks like a saboteur copy is refused.
- On Ctrl-C or SIGTERM during `CREATE DATABASE` it cancels its own `CREATE` (`pg_cancel_backend`, allowed only for
  the backend that runs it), waits up to 30 seconds for it to end, and drops the copy. If it cannot, it prints the
  database name and the command to drop it, and exits 1.
- A `--db-url` or `--admin-url` with `dbname`, `host`, `options`, `user`, `port`, `service` or a similar parameter
  in its query string is refused (exit 2): psql and the Supabase CLI let those override the URL. Every connection
  checks `current_database()`. `--admin-url` must be the same server as `--db-url`, or the run exits 2.
- A test command gets no variable that names another database. The tool removes every environment variable whose name
  contains `DATABASE`, `DB_URL`, `DBURL`, `DB_CONNECTION`, `DIRECT_URL`, `POSTGRES`, `SUPABASE` or `SERVICE_ROLE`
  (any case), and every `PG*` variable. Then it sets `DATABASE_URL`, `SABOTEUR_DB_URL` and `PG*` to the copy. The plan
  lists the removed names. Files your test framework loads itself (`.env`, `.env.local`, `.env.test`) are not
  controlled; the plan warns, by file name, about one that mentions a database.
- Outbound HTTP from a copy is switched off by default (`pg_net` and `http` functions do nothing in the copy).
  `--no-isolate-network` turns that off. `dblink`, `postgres_fdw` and the untrusted languages are not switched off;
  the report names them when the database has them.
- It closes other sessions on the source only on a local host, only after its own yes (the question, or
  `--close-sessions`; `--yes` is not enough), and never with `--no-terminate` or the remote flag. With `--admin-url`
  it also needs proof that the admin connection is on the same server (system identifier or data directory); a match
  of host and port alone is not enough.
- Before copying anything it prints a plan and asks `Continue? (y/N)`. With no terminal it exits 2 unless you
  pass `--yes`. A test command from `.rls-saboteur.json` is shown and confirmed before it runs.
- Names and text from the database or from a subprocess are written out visibly (`\x1b`) before they reach the
  console or the report.
- A `.rls-saboteur.json` `test` value and `--test` run as shell commands, like `package.json` scripts.
  Run the tool only in projects you trust.
- Never pass untrusted text (pull request titles, branch names, comment bodies) to the Action's `extra-args`
  or `test` inputs. Use `permissions: contents: read` on workflows that use the Action.
- A crash (`SIGKILL`, power loss) cannot leave your database changed. It can leave a copy named `saboteur_...`.
  The next run drops it if its name or label shows it was made by this host and its process is dead. This holds
  even for a copy that was killed between `CREATE DATABASE` and its label.
- **What a copy can still do.** Test files are your code and run with your database user's rights on the same
  server as your database. The pgTAP runners (`supabase test db`, `--runner psql`) run each file as the user in
  `--db-url`, so a `\c otherdb` or a `dblink` call in a test file can reach other databases on that server. The tool
  cannot prevent that without a separate role. Read your test files before you run them.
- The test command (`--test` or the config file) is your own code. Its environment holds no variable that names another
  database, but it is a shell command and runs as you: it can read files such as `~/.pgpass` or a `.env` file and open
  network connections.
