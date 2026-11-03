# Instructions for AI coding agents

This file is for any AI coding agent. Humans: read [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

- To **run RLS Saboteur** against a project, read "Running the tool" below.
- To **change this repository**, read "Working on this repository" below.

## Running the tool

RLS Saboteur breaks each Postgres RLS policy in a throwaway copy of the database, runs the project's tests, and lists every break that no test caught.

### Commands

```sh
npx rls-saboteur --dry-run               # list the breaks as text on stdout and stop; no tests run, no JSON
npx rls-saboteur --yes --json            # full run, no prompt, JSON on stdout
npx rls-saboteur --checks-only --json    # only the checks that need no tests
```

- Run it from the project root. The tool reads `supabase/config.toml`, the policies in the catalogue and the pgTAP files in `supabase/tests`.
- Every option is in [docs/options.md](docs/options.md). Without Supabase, read [docs/plain-postgres.md](docs/plain-postgres.md).
- Against a local Supabase stack, pass `--admin-url postgres://supabase_admin:postgres@127.0.0.1:<port>/postgres` if the copy step fails with "postgres still has connections that this role cannot close". Use the database port from `supabase status`.

### Inputs and approval

- You have no terminal to answer the plan question. Pass `--yes`, and only for a run whose plan you have read (`--dry-run` shows the breaks).
- `--dry-run` writes plain text only. It never writes JSON. With `--json` its text goes to stderr and stdout stays empty. For JSON, run without `--dry-run`.
- `--yes` approves the plan and a test command from `.rls-saboteur.json`. It does not approve closing other sessions on the database. That needs `--close-sessions`. Pass it only on a local database you started yourself.
- Without a terminal and without `--yes`, the tool exits 2 and names `--yes`.
- `--test "<command>"` and the `test` value in `.rls-saboteur.json` run as shell commands. Do not run the tool with a config file you have not read.

### Outputs

- `--json` writes one JSON object to stdout. The console report goes to stderr.
- `--json-file <path>` writes the same JSON to a file.
- `--report <path>` writes the Markdown report. The default is `saboteur-report.md`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed. |
| `1` | The score is below the threshold, or a check failed. |
| `2` | The tool could not check: tests fail unchanged, no tests, refused database, no connection, or a bad option value. |

A run in which no break was decided exits 2, never 0.

### How to read the report

- **Caught** means a test failed with the break in place. That is good.
- **Missed** means the tests still passed with the policy broken. Each miss is a hole in the tests. The report names the table, the policy, the break and how many test files mention the table.
- **Error** means the tests could not run on that copy. An error is never a catch. If any break errored, the score may be too high. Fix the cause and run again.
- The score is caught divided by caught plus missed.
- Lines under "Checks without tests" report grant and role problems. A `FAIL` there makes the exit code 1. See [docs/checks-without-tests.md](docs/checks-without-tests.md).

### The loop

1. Run the tool and read the missed breaks.
2. Write one pgTAP test for each miss. The test must fail when that policy is broken.
3. Run the tool again. Stop when the misses are gone or each remaining one has a written reason in `skip` in `.rls-saboteur.json`.

The Claude Code plugin in `plugin/` does this loop. Install it with `/plugin marketplace add mattmuller/rls-saboteur`, then `/plugin install rls-saboteur@rls-saboteur`. The `/sabotage` command starts it, and `plugin/skills/rls-saboteur/SKILL.md` holds the steps. See [docs/claude-code.md](docs/claude-code.md).

### Safety limits

- It never changes the database you point it at. It reads it, and your rows are copied into temporary databases on the same server, which are dropped afterwards. See [docs/safety.md](docs/safety.md).
- It refuses a database that is not local. Do not pass `--allow-remote-i-understand-this-locks-tables`.
- Do not pass `--no-isolate-network`. It turns outbound HTTP on inside the copies.
- A source over 2 GB needs `--max-size`. Ask the user before you raise it.
- The copies hold the same rows as the source. To keep real rows out, use `--sandbox --from-files`: it reads no real row. `--mask` is not a privacy control and does not make real personal data safe to share; it only rewrites the columns you name in the first copy. See [docs/sandbox.md](docs/sandbox.md).
- Do not add a skip to `.rls-saboteur.json` to make a run pass. Every skip needs a written reason.

### HOL Guard

If your agent runs under [HOL Guard](https://github.com/hashgraph-online/hol-guard), its `command.rls-saboteur` extension asks before an agent runs RLS Saboteur with a risky option. See [docs/related-tools.md](docs/related-tools.md#hol-guard).

## Working on this repository

## Safety rules

**1. The tool must never change anything but its own copies.** Do not add a statement that touches the user's database. Every connection goes through `Guard` in `src/guard.ts`, an allowlist of the statements the tool itself sends. Keep it narrow.

**2. Run Docker containers only on ports 56000 to 56999** when you start your own. `npm run test:matrix` uses 55416, 55417, 55516 and 55517 and removes its containers when it ends. Never connect to a database you did not start. Remove your own containers when you finish.

**3. Do not commit, tag, push or publish unless the task asks for it.** The release workflow publishes. A human pushes the tag.

## Setup and commands

Node 22 or newer. Run `npm ci` once.

- `npm run type-check` compiles with no output.
- `npm test` runs the unit tests.
- `npm run test:matrix` runs the end-to-end tests on PostgreSQL 16 and 17 in Docker.
- `npm run build` compiles `dist/`.

Run type-check, test and build before you say a change is done. Run the matrix if you touched the guard, the isolation code, the test runners or the CLI.

## Rules, and why

1. **Prove every new test can fail.** Break the code under test, see the test go red, then restore the code. A test that never failed may check nothing.
2. **[docs/safety.md](docs/safety.md) names a test for every guarantee.** Use the exact test name. If you change a test name or a guarantee, change that page in the same commit.
3. **Keep the project generic.** Use neutral subjects in examples, tests and docs. Use no company, product or other project names.
4. **Report security problems through [SECURITY.md](SECURITY.md).** Never write an exploit into an issue, a test name or a commit message.
5. **Write short sentences.** One action per sentence. Active voice. No hedging. Lead with the outcome.
6. **Keep `SECURITY.md` and `plugin/SECURITY.md` identical.**

## Repo map

`src/`

- `cli.ts`: command-line entry. Parses and checks options, sets exit codes.
- `run.ts`: the run: read the catalogue, build the plan, ask, copy, break, report.
- `guard.ts`: the allowlist guard, copy names, `droppable()`, the host id.
- `isolation.ts`: the master template, per-break copies, the sweep, and cleanup on a signal.
- `facts.ts`: size and server facts, and the same-server test.
- `tests.ts`: the test runners (supabase, psql, custom) and the environment given to them.
- `safety.ts`, `urls.ts`, `options.ts`: the local-host check, URL checks, option parsing.
- `breaks.ts`, `catalogue.ts`, `checks.ts`: the break generator, the policy catalogue and the checks that need no tests.
- `confirm.ts`, `report.ts`, `config.ts`: questions, reports, config and secret scrubbing.

Other folders:

- `test/`: unit tests (`npm test`). `test/matrix/` holds the end-to-end tests that need Docker. `test/docker/` builds the Postgres image with pgTAP.
- `plugin/`: the Claude Code plugin and skill.
- `examples/demo/`: a demo project with a weak and a fixed suite.
- `scripts/`: release helpers (`changelog-section.mjs`).
- `.github/`: CI, release workflow, issue and pull request templates.
