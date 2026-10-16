# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- README: a HOL Guard section. HOL Guard now ships the `command.rls-saboteur` extension (hol-guard#4636), which asks before an agent runs RLS Saboteur with a risky option.

### Changed

- The GitHub Action now uses `supabase/setup-cli` v3.0.1 (installs the Supabase CLI from npm) and `actions/upload-artifact` v7.0.2. Its inputs and the report artifact are unchanged.
- Development: TypeScript 7 and `actions/setup-node` v7.1.0.

## [0.2.0] - 2026-10-14

The tool can now change only its own temporary copies. Every item below says what was wrong before.

### Security

- Every connection goes through one guard (`src/guard.ts`). The guard is an allowlist of the statements the tool itself sends: plain reads on the source, and `CREATE DATABASE`, `COMMENT ON DATABASE`, `DROP DATABASE` and closing sessions on the admin connection. Anything else is refused before it is sent. The source session is also opened read-only, so Postgres refuses a write. Before, the tool sent the source ordinary statements, including `ALTER DATABASE`.
- Removed `--isolation in-place`. `--isolation in-place` now exits 2 and says why. Before, in-place mode applied each break to your real database, and a crash or `kill -9` could leave a policy broken.
- The baseline test run happens on an unchanged copy, never on the source. Before, it ran on your database.
- A database is dropped only when `droppable()` allows it: it is not your database, and it was made by this run, or by a dead process of this host. Before, a name prefix was enough.
- A copy now carries its maker in its NAME: `saboteur_<host id>_<pid>_<run token>_tpl` or `..._<n>`. The label (`COMMENT ON DATABASE`) is a second record. Before, the identity lived only in the label, so a copy whose `CREATE DATABASE` finished after the CLI was interrupted (or killed between `CREATE` and `COMMENT`) had no label, and no later run ever swept it. A 659 MB source left a full copy behind.
- Ctrl-C and SIGTERM during `CREATE DATABASE` now cancel the tool's own `CREATE` with `pg_cancel_backend` on that exact backend, wait up to 30 s for it to end, and then drop the copy. The guard allows a cancel only for a backend pid it saw running one of the tool's `CREATE` statements. If a copy cannot be removed, the tool prints the database name and the `drop database` command, and exits 1. Before, the CLI exited at once and the server finished the copy afterwards.
- A `--db-url` whose database name is the name of a saboteur copy is refused with exit 2.
- Copies left by a pre-release build of 0.2.0 (named `saboteur_<pid>_...`) are recognised only through their label, and the host id changed, so the tool will not sweep them. Drop any such database by hand.
- The host id also includes the Linux pid namespace. Before, two containers that shared a kernel and a hostname had the same id, so one could judge the other's live pid dead.
- Closing other sessions on the source (`--close-sessions`) is allowed only when the admin connection is PROVEN to be on the same server, by the cluster system identifier or the data directory. On the host and port fallback the copy may proceed but closing sessions is refused. `localhost` is no longer treated as equal to `127.0.0.1`. The guard also checks that the session-closing statement is bound to the source database name. Before, the guard checked the SQL text only.
- A `--db-url` or `--admin-url` with `dbname`, `database`, `host`, `options`, `user`, `port` or `service` in its query string is refused with exit 2. Every connection checks `current_database()`. Before, psql and the Supabase CLI let those parameters send a runner to another database.
- `--admin-url` must be the same server as `--db-url`, or the run exits 2 before anything is created.
- The test command gets the copy only. Every environment variable whose name contains `DATABASE`, `DB_URL`, `DBURL`, `DB_CONNECTION`, `DIRECT_URL`, `POSTGRES`, `SUPABASE` or `SERVICE_ROLE`, and every `PG*` variable, is removed. `DATABASE_URL`, `SABOTEUR_DB_URL` and `PG*` then point at the copy. The plan lists the removed names, never the values. Before, a fixed list was removed with an anchored match, so `TEST_DATABASE_URL`, `SHADOW_DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` reached the test command.
- The plan warns, by file name only, when a `.env`, `.env.local`, `.env.test` or `.env.test.local` file in the working directory mentions a database. Files your test framework loads itself are not controlled. Before, nothing warned about them.
- The plan says that test files run with your database user's rights on the server, so `\c` or `dblink` inside one can reach other databases there. This is documented in the README and SECURITY.md.
- Outbound HTTP from a copy is switched off: the `net`, `pg_net` and `http` functions keep their signatures and do nothing in the copies. `--no-isolate-network` turns that off. A role that cannot replace the functions gets exit 2. Before, a trigger in a copy could call an outside service.
- Names and text from the database or a subprocess are written out visibly (`\x1b`) before they reach the console, the report or a confirmation question. Before, a policy name could carry terminal escape sequences.
- Confirmation: the tool prints a plan and asks `Continue? (y/N)`. With no terminal it exits 2 unless you pass `--yes`. Closing sessions needs its own yes (`--close-sessions`); `--yes` does not give it. A test command from `.rls-saboteur.json` is shown before it runs.
- A source over 2 GB is refused unless you pass `--max-size`. The plan prints the server version, the size, the other sessions and the address the server reports.

### Added

- The options `--close-sessions`, `--max-size`, `--no-isolate-network` and `--yes`.
- `scripts/changelog-section.mjs`, the release workflow, contributor and agent documents.
- A matrix test with a real SIGINT and SIGTERM during `CREATE DATABASE`, during the first copy and during a per-break copy, and a `kill -9` test. They assert that no `saboteur_*` database remains.
- The matrix starts a second throwaway server so that the different-server `--admin-url` test runs on PostgreSQL 16 and 17.
- The Action input `close-sessions`.

### Changed

- Values are checked: `--threshold` outside 0 to 100, `--jobs` below 1 or not whole, a bad `--timeout`, `--max-size` or `--runner` exit 2. Before, `--runner bogus` was treated as `auto`, and some bad values became defaults.
- A run in which no break was decided (none run, all skipped, all errored) exits 2. Before, it could exit 0.
- The GitHub Action closes other sessions by default only when it starts its own Supabase stack (`start-supabase: true`). Before, the default was always true. Set `close-sessions` to override.
- The plan and the README now describe the guard as an allowlist of the statements the tool itself sends.
- The README guarantees each name a test that exists and runs in `npx vitest run` or `npm run test:matrix`.

### Removed

- `--isolation in-place`. See Security.

## [0.1.1] - 2026-10-14

### Security

- A host name such as `supabase_db_x.evil.com` is no longer treated as local. Only a one-label container name such as `supabase_db_project` is. Before, any name that started with `supabase_db_` passed. (230afa8)
- `{{db_url}}` in a test command is shell-quoted (POSIX single quotes; on Windows a URL with `"`, `%` or `!` is refused). Before, a password with `$` or a backtick could run a command. (230afa8)
- Passwords no longer appear in the argument list of `psql` or the Supabase CLI. They travel in `PGPASSWORD`. Before, `ps` showed them. (230afa8)
- The Action pins `setup-node`, `setup-cli` and `upload-artifact` to commit SHAs. Before, they used moving tags. (230afa8)
- Documentation: `--test` and the config file run shell commands, never pass untrusted text to `extra-args`, use `permissions: contents: read`. (230afa8)
- Updated to vitest 5 (`npm audit` reports 0). (230afa8)

## [0.1.0] - 2026-10-06

### Added

- Mutation testing for Postgres and Supabase row level security: it breaks each policy on purpose, one at a time, runs your tests, and lists every break the tests did not catch. (1bbb7e1)
- Zero configuration against a local Supabase stack; pgTAP runners for `supabase test db` and `psql`; any other test command through `--test`. (6a2518f, 6dc3adb)
- Catalogue checks that need no tests. (6a2518f)
- Credentials are scrubbed from test output and errors before they reach a report. (e68f421, 0a25156)
- A Claude Code plugin, a marketplace entry and a GitHub Action. (cdc61b4)
- A demo project with a passing but weak suite and a fixed suite. (ff9378d)
- A fixture matrix of six synthetic schemas, run end to end on PostgreSQL 16 and 17. (642c948)

[Unreleased]: https://github.com/mattmuller/rls-saboteur/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mattmuller/rls-saboteur/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mattmuller/rls-saboteur/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mattmuller/rls-saboteur/releases/tag/v0.1.0
