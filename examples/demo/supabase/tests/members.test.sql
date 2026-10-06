begin;
select plan(3);

insert into public.orgs (id, name, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', 'Acme', '11111111-1111-1111-1111-111111111111');
insert into public.members (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('a0000000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select count(*)::int from public.members), 2, 'a member sees the members of their org');
select throws_ok(
  $$insert into public.members (org_id, user_id, role)
    values ('a0000000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'admin')$$,
  '42501', null, 'a plain member cannot promote themselves');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.members (org_id, user_id, role)
    values ('a0000000-0000-0000-0000-00000000000a', '44444444-4444-4444-4444-444444444444', 'member')$$,
  'an owner adds a member');

select * from finish();
rollback;
