# Related tools

- [SupaShield](https://github.com/Rodrigotari1/supashield) is a command-line tool that audits and lints RLS, maps access per role, snapshots policies, and exports pgTAP tests.
- [rlsautotest](https://github.com/unitautogen/rlsautotest) generates a pgTAP suite and its seed data from your policies, including two-tenant isolation.
- [rlsgrid](https://github.com/matte97p/rlsgrid) maps role, table and operation, then fuzzes cross-tenant reads and writes.
- [splinter](https://github.com/supabase/splinter) is Supabase's own linter. It checks database settings and powers the Security Advisor.
- [supabase-test-helpers](https://github.com/usebasejump/supabase-test-helpers) provides pgTAP helpers for signing in as a user inside a test.

RLS Saboteur works on top of the tests that SupaShield and rlsautotest generate: generate a suite with one of them, then run RLS Saboteur to see which breaks that suite misses.

## HOL Guard

[HOL Guard](https://github.com/hashgraph-online/hol-guard) reviews the commands an AI agent runs before they run. It ships an extension for RLS Saboteur, [`command.rls-saboteur`](https://github.com/hashgraph-online/hol-guard/blob/main/contributions/extensions/command.rls-saboteur.json), added in [hol-guard#4636](https://github.com/hashgraph-online/hol-guard/pull/4636). It has four permissions:

| Permission | Tier | It covers |
|---|---|---|
| `copy-run` | medium | any run, because a run copies your database |
| `remote-override` | high | `--allow-remote-i-understand-this-locks-tables` |
| `close-sessions` | high | `--close-sessions` |
| `no-isolate-network` | medium | `--no-isolate-network`, which turns off network isolation in the copies |

Turn a permission off and Guard blocks that kind of run instead of asking. It recognises `rls-saboteur` run directly and through npx, npm, pnpm, yarn and bun, with or without a version. One limit: after npm's own `--` on a versioned launch (`npm exec rls-saboteur@x -- ...`), a flag is matched only when it comes first or right after `--yes`; in any other position that run is still reviewed as a `copy-run`.
