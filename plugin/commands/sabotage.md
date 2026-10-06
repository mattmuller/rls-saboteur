---
description: Break each RLS policy on purpose, show which breaks the tests miss, then write the missing pgTAP tests and prove they catch them.
argument-hint: "[extra rls-saboteur options]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run RLS Saboteur on this project, show the result, and close the gaps.

## 1. Run it

Check that a local Supabase is running (`supabase status`). If it is not, tell the user to run `supabase start` and stop.

Run this from the project root. Add any options the user passed: $ARGUMENTS

```
npx rls-saboteur --json-file saboteur-report.json
```

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

Run the tool again with only the breaks you targeted, using `--filter` with the table name for each:

```
npx rls-saboteur --filter "<schema>.<table>/" --json-file saboteur-report.json
```

Every break you wrote a test for must now be `caught`. If one is still missed, read the new test, fix it, and run again. Stop after three rounds on the same break and tell the user what blocks it. Some breaks are equivalent to the original policy (for example the condition is redundant). Say so, and suggest a skip with a written reason in `.rls-saboteur.json`.

Finish by running the full command once more and print the new score.
