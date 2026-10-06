-- The tests the first run said were missing. Each one signs in as a user from
-- ANOTHER org, or tries to write something the policy must refuse.
begin;
select plan(6);

insert into public.orgs (id, name, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', 'Acme',  '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-00000000000b', 'Bravo', '22222222-2222-2222-2222-222222222222');
insert into public.members (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'admin');
insert into public.documents (id, org_id, author_id, title) values
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Acme plan');
insert into public.invoices (id, org_id, issued_by, amount_cents) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 5000);

-- A Bravo user tries to change and delete Acme's document. Both match no rows.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
update public.documents set title = 'hacked';
delete from public.documents;
select is((select count(*)::int from public.members where org_id = 'a0000000-0000-0000-0000-00000000000a'), 0,
  'a user from another org does not see the members of this org');

reset role;
select is((select title from public.documents where id = 'd0000000-0000-0000-0000-000000000001'), 'Acme plan',
  'another org cannot change or delete a document');

-- An Acme admin tries to move an invoice into Bravo, and to forge who issued one.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$update public.invoices set org_id = 'b0000000-0000-0000-0000-00000000000b'$$,
  '42501', null, 'an admin cannot move an invoice into another org');
select throws_ok(
  $$insert into public.invoices (org_id, issued_by, amount_cents)
    values ('a0000000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 100)$$,
  '42501', null, 'an admin cannot issue an invoice in someone else''s name');

-- A Bravo admin cannot touch or read Acme invoices.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
update public.invoices set paid = true;
select is((select count(*)::int from public.invoices), 0, 'another org reads no invoices');
reset role;
select is((select paid from public.invoices where id = 'e0000000-0000-0000-0000-000000000001'), false,
  'another org cannot update an invoice');

select * from finish();
rollback;
