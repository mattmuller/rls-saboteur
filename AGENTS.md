# Instructions for AI coding agents

This file is for any AI coding agent that works in this repository. Humans: read [CONTRIBUTING.md](CONTRIBUTING.md).

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
2. **The README names a test for every guarantee.** Use the exact test name. If you change a test name or a guarantee, change the README in the same commit.
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
