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
2. Show the user the plan in the chat and get an explicit yes. The tool asks "Continue? (y/N)" itself, but an agent has no terminal, so it can only run with `--yes`, which approves the plan and a config-file test command. **Never add `--yes` on the user's behalf without their yes to this plan.** Otherwise you approve, in their name, a plan they never saw. The plan: the database (name, host, local or not), how many policies will be broken (`npx rls-saboteur --dry-run` lists them and asks nothing), the test command (show a command from `.rls-saboteur.json` exactly, it runs as the user), and that "It will not change this database. It works on temporary copies." Also say that pgTAP test files run with the user's database rights on the same server, so they should read them first.
   **Closing other sessions is a second question with its own yes.** If the database has other connections open (a running local Supabase always does), ask "Close the other sessions for a moment?". `--yes` does not approve this. Add `--close-sessions` only after the user says yes to it.
   **A yes belongs to one plan.** When you run the tool again (a `--filter` re-run, a final full run), reuse the earlier yes only if the database, the test command and the number of breaks are the same. If any changed, show the new plan and ask again.
3. After the yes, run `npx rls-saboteur --yes --json-file saboteur-report.json` from the project root (add `--close-sessions` only as above).
4. Read the exit code: 0 all caught, 1 misses or a failed check, 2 could not check.

Options you may need: `--sandbox` (run the copies in a throwaway Docker container instead of on the user's server; ask first, it starts a container and, without `--from-files`, streams the rows into it), `--from-files` (needs `--sandbox`; build the copies from `supabase/migrations` and `supabase/seed.sql` so no real row is read), `--mask schema.table.column` (scramble a column before any break runs; the run stops if it cannot), `--test "<cmd>"` for a custom test command, `--schemas a,b`, `--jobs 4`, `--only-related`, `--dry-run` to list the breaks, `--checks-only` for the checks that need no tests.

The tool refuses a non-local database. Never pass `--allow-remote-i-understand-this-locks-tables` on the user's behalf.

## What to do with the result

- For each missed break, write a pgTAP test that passes on the real policy and fails with the break. The `/sabotage` command has the full recipe.
- A `FAIL` under "Checks without tests" is a real defect (a policy calls a function its role cannot execute, a custom role inherits anon, an inert column grant, or `current_user` in a SECURITY DEFINER function). Propose a migration. Do not apply it.
- Never weaken a policy to make a test pass.
