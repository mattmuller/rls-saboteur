begin;
select plan(5);

insert into public.orgs (id, name, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', 'Acme',  '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-00000000000b', 'Bravo', '22222222-2222-2222-2222-222222222222');
insert into public.members (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('a0000000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'admin');
insert into public.invoices (id, org_id, issued_by, amount_cents) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 5000),
  ('e0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 9000);

-- An Acme admin sees invoices.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select ok((select count(*) from public.invoices) >= 1, 'an admin reads invoices');
select lives_ok(
  $$insert into public.invoices (org_id, issued_by, amount_cents)
    values ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 1200)$$,
  'an admin creates an invoice');
select lives_ok(
  $$update public.invoices set paid = true where id = 'e0000000-0000-0000-0000-000000000001'$$,
  'an admin updates an invoice');

-- A plain member sees none.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select count(*)::int from public.invoices), 0, 'a plain member reads no invoices');
select throws_ok(
  $$insert into public.invoices (org_id, issued_by, amount_cents)
    values ('a0000000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 1)$$,
  '42501', null, 'a plain member cannot create an invoice');

select * from finish();
rollback;
