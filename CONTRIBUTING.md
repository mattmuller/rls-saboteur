# Contributing

Thank you for helping. This page tells you how to set up, which commands to run, and the rules each change must follow.

## Set up

You need Node 22 or newer. The matrix tests also need Docker.

```sh
git clone https://github.com/mattmuller/rls-saboteur.git
cd rls-saboteur
npm ci
```

## Commands

| Command | What it does |
|---|---|
| `npm run type-check` | Runs the TypeScript compiler with no output. |
| `npm test` | Runs the unit tests with vitest. No database is needed. |
| `npm run test:matrix` | Builds the CLI, starts throwaway PostgreSQL 16 and 17 servers in Docker, and runs the end-to-end tests. Takes several minutes. |
| `npm run build` | Compiles `src/` into `dist/`. |

Run type-check, test and build before you open a pull request. Run `test:matrix` as well when you touch `src/guard.ts`, `src/isolation.ts`, `src/tests.ts` or `src/cli.ts`. CI runs the unit tests on Node 22 and 24, and the matrix on PostgreSQL 16 and 17.

`npm run test:matrix` creates only containers named `rls-saboteur-ci-*`, on ports 55416, 55417, 55516 and 55517. It never touches another container or a volume.

## House rules

**1. The tool must never change anything but its own copies.** This is the rule that matters most. Every connection goes through `Guard` in `src/guard.ts`, which is an allowlist of the statements the tool itself sends. If you add a new statement, add it to the allowlist in the narrowest shape that works, and add a test that shows the guard refuses every other shape.

**2. Prove every new test can fail.** Break the code the test covers. Run the test. See it go red. Restore the code. A test that has never failed may check nothing, and this project exists to catch that mistake. Write "yes" in the pull request template when you did this.

**3. Name the test for each guarantee.** The README lists each guarantee with the exact name of the test that checks it. If you rename a test, update the README. If you add a guarantee, add the test first.

**4. Keep the project generic.** Examples, fixtures and docs use neutral subjects such as organisations, documents and invoices. Use no company, product or other project names.

**5. Send security reports through [SECURITY.md](SECURITY.md), not issues.** A public issue shows an attack before there is a fix. Use the private advisory page that file links to.

## Writing style

Write short sentences. Put one action in each sentence. Use the active voice. Say "will" or "must", not "may" or "should". Lead with the outcome.

## Releasing

Only a maintainer releases. The steps are:

1. Bump `version` in `package.json` (run `npm version <x.y.z> --no-git-tag-version`). Set the `version` default in `action.yml` to the same number.
2. Move the "Unreleased" entries in `CHANGELOG.md` under a new `## [x.y.z] - date` heading. Update the links at the bottom. A release without a changelog section for its version fails.
3. Commit and merge to `main`.
4. Tag the commit `vX.Y.Z` and push the tag. The tagged commit must be on `main`.

The release workflow has two jobs. `verify` has read-only permission. It checks that the tag equals the package version, that the tagged commit is an ancestor of `origin/main`, that `CHANGELOG.md` has a section for the version, and that `action.yml` defaults to the same version. It then runs `npm ci`, the type check, the unit tests and the build. `publish` runs only when `verify` passes. It alone has `id-token: write` and `contents: write`. It installs with `npm ci --ignore-scripts`, builds, publishes to npm with provenance, and creates the GitHub release from the changelog section. The workflow uses npm trusted publishing, so no npm token is stored. The matrix runs in CI on every push to `main`; check that it is green before you tag.
