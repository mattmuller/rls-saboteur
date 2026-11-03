# Tested against

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
- The column swap is only generated for `auth.uid()` comparisons (see [Plain Postgres](plain-postgres.md)).
- Policies on a partition are broken separately from the parent's, because Postgres applies them separately. A partition with no RLS of its own has nothing to break.

## Linux (sandbox mode)

What is proven, and where:

- **Docker Engine installed directly on a host (GitHub Actions `ubuntu-latest`, PostgreSQL 16 and 17).** The whole matrix runs there on every push: `--from-files` end to end, the network probe, the relay, dump mode against a source published on `127.0.0.1` only, masking, the sweep, signals. On the 17 run the four Supabase tests run too, on the public Supabase image. See `.github/workflows/ci.yml`.
- **A `docker:dind` container (Alpine, Engine 29.9.2) as the Docker host through `DOCKER_HOST`**, by hand, before the CI run existed: `--from-files` with `postgres:17`, and the network probe. It showed that `--network none` blocks `1.1.1.1`, the bridge gateway and loopback with an empty routing table, and that an internal Docker network (`docker network create --internal`) reached its own gateway on the engine host (`172.19.0.1:2375`, the engine's API port). That is why `--network none` is used and an internal network is not.
- **Docker Desktop for Mac** (Docker 29.9.2): the whole matrix, on PostgreSQL 16 and 17, with the Supabase tests.

Three things only Linux CI found in 0.3.0, all fixed:

- A source on `127.0.0.1` could not be dumped, because `host.docker.internal` does not reach loopback on Linux Engine. Fixed by the host-network `pg_dump` helper, which is limited and announced (see "Reaching your database from the container" in [Sandbox](sandbox.md#sandbox---sandbox)). The CI tests that use a chosen image pass `--sandbox-host-network`.
- A client of the relay that disappeared without the closing message left its session open in the container for good, because the relay's reader kept the socket after the writer had ended. That kept the master copy "in use" and failed the next `CREATE DATABASE ... TEMPLATE`. The relay script now closes its end of the connection when its input ends. Proof: `sandbox-relay-no-leak`.
- The `sandbox-isolated` control assumed Docker Desktop. It tried to connect from the default network to the loopback-only test database, which Linux Engine refuses, so the control could not show that the probe works. It now connects to a listener on all interfaces, which both engines allow.

Not tested: Windows; Podman or rootless Docker; a Linux engine behind a firewall that drops traffic from the bridge to the host (the dump helper uses the host network, but a source on a non-loopback address still goes through the bridge); `--sandbox` with the Supabase image against a source on loopback on Linux is covered only by the CI test `sandbox-supabase-dump`.
