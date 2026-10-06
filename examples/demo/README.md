# Demo: a suite that passes and misses six breaks

A small multi-tenant app: `orgs`, `members`, `documents`, `invoices`, twelve policies.

- `supabase/tests` is a pgTAP suite that looks complete and passes (25 tests).
- `fixed/tests` is the same suite plus `cross-tenant.test.sql`, which closes the six gaps.

The project uses ports 55320 to 55327, so it never clashes with another local Supabase.

```sh
cd examples/demo
supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor

# before: 36 of 42 breaks caught, 6 missed
npx rls-saboteur --admin-url postgres://supabase_admin:postgres@127.0.0.1:55322/postgres

# after: 42 of 42
npx rls-saboteur --admin-url postgres://supabase_admin:postgres@127.0.0.1:55322/postgres --tests-dir fixed/tests

supabase stop --no-backup
```

The six misses, and what each means:

| Policy | Break | What the tests never check |
|---|---|---|
| documents: authors delete own | USING true | that a user from another org cannot delete |
| documents: authors update own | USING true | that a user from another org cannot update |
| invoices: admins create | `issued_by = auth.uid()` removed | that an admin cannot issue an invoice in someone else's name |
| invoices: admins update | USING true | that another org's admin cannot update |
| invoices: admins update | WITH CHECK removed | that an invoice cannot be moved into another org |
| members: read co-members | USING true | that an outsider cannot read the member list |
