---
name: rls-saboteur
description: Use when the user asks whether their Postgres or Supabase RLS tests are good enough, wants to find RLS policies that no test guards, or has just written or changed an RLS policy. Runs RLS Saboteur, which breaks each policy on purpose and reports which breaks the tests do not catch.
---

# RLS Saboteur

Passing RLS tests prove little unless they fail when a policy breaks. RLS Saboteur breaks each policy in turn on a throwaway copy of the local database and re-runs the tests. A break that no test notices is a "missed" break: a real hole.

## When to use it

- The user asks if their RLS tests are complete or trustworthy.
- You just added or edited a policy. Run it with `--filter "<schema>.<table>/"` to check that table.
- Before a release that touches grants, roles or policies.

## How to run it

1. Confirm a local Supabase is running: `supabase status`.
2. Run `npx rls-saboteur --json-file saboteur-report.json` from the project root.
3. Read the exit code: 0 all caught, 1 misses or a failed check, 2 could not check.

Options you may need: `--test "<cmd>"` for a custom test command, `--schemas a,b`, `--jobs 4`, `--only-related`, `--dry-run` to list the breaks, `--checks-only` for the checks that need no tests.

The tool refuses a non-local database. Never pass `--allow-remote-i-understand-this-locks-tables` on the user's behalf.

## What to do with the result

- For each missed break, write a pgTAP test that passes on the real policy and fails with the break. The `/sabotage` command has the full recipe.
- A `FAIL` under "Checks without tests" is a real defect (a policy calls a function its role cannot execute, a custom role inherits anon, an inert column grant, or `current_user` in a SECURITY DEFINER function). Propose a migration. Do not apply it.
- Never weaken a policy to make a test pass.
