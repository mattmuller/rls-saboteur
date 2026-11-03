# RLS Saboteur

[![npm version](https://img.shields.io/npm/v/rls-saboteur)](https://www.npmjs.com/package/rls-saboteur)
[![CI](https://github.com/mattmuller/rls-saboteur/actions/workflows/ci.yml/badge.svg)](https://github.com/mattmuller/rls-saboteur/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/npm/l/rls-saboteur)](LICENSE)

Mutation testing for Postgres and Supabase Row Level Security. It breaks each policy on purpose and lists every break your tests missed.

## Why

Your RLS tests pass. That does not tell you they would fail if a policy broke.

RLS Saboteur breaks each policy in turn, in a throwaway copy of your database, and runs your tests against the copy. A break that no test notices is listed as **missed**. A missed break is a real hole: a policy that could go wrong with no test to say so.

Stryker and PIT do this for application code. Tools like rlsautotest and SupaShield write RLS tests. RLS Saboteur checks the tests, whoever wrote them.

## Before and after

`examples/demo` is a small multi-tenant app with a pgTAP suite that looks complete and passes.

```
$ npx rls-saboteur
Baseline   all 25 tests pass
  caught  36 / 42
  MISSED   6 / 42  your tests still pass with these policies broken
  MISSED  documents  "authors delete own documents"
          USING (author_id = auth.uid())
          break: USING replaced with true  → any authenticated deletes every row in the table, whatever tenant it belongs to
  ... 5 more in saboteur-report.md
Score  86%   exit 1 (threshold 100%)
```

Add one test for each miss, and the same project scores 100%:

```
$ npx rls-saboteur --tests-dir fixed/tests
  caught  42 / 42
Score  100%   exit 0 (threshold 100%)
```

The full output is in [How it works](docs/how-it-works.md#worked-example).

## Install and run

You need Node 22 or newer. For a local Supabase project:

```sh
supabase start
npx rls-saboteur
```

There is no configuration. The tool reads the database port from `supabase/config.toml`, every policy from the Postgres catalogue, and your pgTAP files from `supabase/tests`. It shows a plan and waits for your yes before it copies anything.

Not on Supabase? See [Plain Postgres](docs/plain-postgres.md). On a local Supabase stack the copy step can need `--admin-url`; see [Options](docs/options.md#local-supabase-the-admin-url).

## What it will never do

- It never changes the database you point it at. It reads it, and copies the rows into temporary databases that it drops afterwards.
- It refuses a database that is not local, unless you pass `--allow-remote-i-understand-this-locks-tables`.
- It never closes your connections without a separate yes.
- It never copies a source over 2 GB unless you pass `--max-size`.
- It switches off outbound HTTP in the copies by default.
- It never runs without asking, unless you pass `--yes`.

Each guarantee is checked by a named test. The full list is in [Safety](docs/safety.md).

## Learn more

- [How it works](docs/how-it-works.md): what breaking a policy means, and what a run does
- [Options](docs/options.md): every flag, exit codes and the config file
- [Safety](docs/safety.md): the guarantees, the tests behind them, and what a copy can still do
- [Sandbox, schema and seed only, and masking](docs/sandbox.md): keep real rows out of the copies
- [Plain Postgres](docs/plain-postgres.md): use it without Supabase
- [Checks without tests](docs/checks-without-tests.md): four catalogue checks that run every time
- [GitHub Action](docs/github-action.md): run it in CI
- [Claude Code](docs/claude-code.md): the plugin and the `/sabotage` command
- [Tested against](docs/tested-against.md): what the test matrix covers and what it does not
- [Roadmap](docs/roadmap.md)
- [Related tools](docs/related-tools.md), including HOL Guard
- [Contributing](CONTRIBUTING.md)

## Licence

MIT. Copyright Matt Muller. See [LICENSE](LICENSE).

AI agents: read [AGENTS.md](AGENTS.md).
