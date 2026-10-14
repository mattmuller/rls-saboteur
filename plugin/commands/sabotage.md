---
description: Break each RLS policy on purpose, show which breaks the tests miss, then write the missing pgTAP tests and prove they catch them.
argument-hint: "[extra rls-saboteur options]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run RLS Saboteur on this project, show the result, and close the gaps.

## 1. Run it

Check that a local Supabase is running (`supabase status`). If it is not, tell the user to run `supabase start` and stop.

Run this from the project root. Add any options the user passed: $ARGUMENTS

**Get the user's approval first. Never approve on their behalf.** The tool asks "Continue? (y/N)" before it copies anything, but it cannot ask you: there is no terminal in this session, so it needs `--yes`, and `--yes` answers yes to every question. The reason for this rule: an agent that adds `--yes` by itself has approved, in the user's name, a plan the user never saw. So:

1. Run a dry run, which asks nothing and changes nothing: `npx rls-saboteur --dry-run $ARGUMENTS`.
2. Show the user, in the chat, this plan: the database (name and host, from the output of the dry run and `supabase status`), the number of policies it will break, the test command, and the line "It will not change this database. It works on temporary copies."
3. If `.rls-saboteur.json` has a `test` command, show the exact command too. It runs as the user.
4. Show the server facts that `--dry-run` prints: PostgreSQL version, size of the database, number of other sessions. The tool refuses a database over 2 GB unless the user gives `--max-size`.
5. If the database has other connections open (a running Supabase stack always does), say that taking the first copy needs them closed for a moment, and that they reconnect by themselves. **This is a second, separate question.** `--yes` does not answer it. Ask "Close the other sessions for a moment?" and wait for its own yes. Only a yes to that question lets you add `--close-sessions`.
6. Ask "Continue?" and wait for an explicit yes in the chat. Silence, a vague answer or an earlier yes for a different plan is not a yes. If the answer is no, stop.

Only after the yes, run with `--yes` (and `--close-sessions` only if the user said yes to closing sessions):

```
npx rls-saboteur --yes --json-file saboteur-report.json
```

**A yes belongs to one plan.** Later steps in this command run the tool again (step 3 re-runs with `--filter`, and there is a final full run). You may reuse the user's yes for a re-run only when the plan is the same: the same database (name and host), the same test command, and the same number of breaks. If any of these changed (a `--filter` changes the number of breaks), show the new plan and ask again before you add `--yes`. Never add `--close-sessions` to a re-run unless the user said yes to closing sessions for this plan.

Print the console report exactly as the tool wrote it. Do not summarise it away.

- Exit 0: say the tests catch every break and stop.
- Exit 2: the tool could not check. Print the reason it gave. Fix nothing yet. If the tests fail unchanged, ask the user.
- Exit 1: continue.

If the report lists a `FAIL` under "Checks without tests", show it and propose the fix as a migration the user can review. Never apply a migration yourself.

## 2. Write a test for each missed break

Read `saboteur-report.json`. For every break with `"outcome": "missed"`:

1. Read the policy in the migration files and the existing tests in `supabase/tests/` that touch the table. Copy their style: how they create users, set `request.jwt.claims`, switch role, and roll back.
2. Write one pgTAP test that passes on the real policy and would fail with the break applied. The break's `effect` field says what to assert:
   - USING replaced with true: sign in as a user from ANOTHER tenant and assert they see zero rows.
   - WITH CHECK removed: try to write a row into another tenant, or as another user, and assert it is rejected (`throws_ok` with `42501`).
   - Condition removed: assert that a row failing exactly that condition is not visible or not writable.
   - auth.uid() compared with the wrong column: assert that a user who owns the row by the OTHER column gets no access.
   - Policy dropped or RLS disabled: assert that the legitimate user still has access, and that an outsider does not.
   - Restrictive made permissive: assert that a row the restrictive policy hides stays hidden.
3. Add it to the test file for that table, or create `supabase/tests/<table>.test.sql`. Keep the `plan(n)` count correct.
4. Never touch the policies or the migrations to make a test pass.

Do not write one test file per break if several breaks are about the same table. Group them.

## 3. Prove it

Run the tool again with only the breaks you targeted, using `--filter` with the table name for each. This is a new plan (fewer breaks): show it and get the user's yes again before you add `--yes`, unless they already approved exactly this filtered run:

```
npx rls-saboteur --filter "<schema>.<table>/" --json-file saboteur-report.json
```

Every break you wrote a test for must now be `caught`. If one is still missed, read the new test, fix it, and run again. Stop after three rounds on the same break and tell the user what blocks it. Some breaks are equivalent to the original policy (for example the condition is redundant). Say so, and suggest a skip with a written reason in `.rls-saboteur.json`.

Finish by running the full command once more and print the new score. That plan has the original number of breaks again: reuse the first yes only if the database and test command are unchanged. Otherwise ask again.
