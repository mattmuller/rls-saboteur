begin;
select plan(4);

insert into public.orgs (id, name, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', 'Home', '11111111-1111-1111-1111-111111111111');
insert into public.members (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is((select count(*)::int from public.orgs where name = 'Home'), 1, 'a member reads their own org');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.orgs), 0, 'a user outside the org does not see it');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.orgs (name, created_by) values ('Mine', '11111111-1111-1111-1111-111111111111')$$,
  'a user creates an org they own');
select throws_ok(
  $$insert into public.orgs (name, created_by) values ('Theirs', '22222222-2222-2222-2222-222222222222')$$,
  '42501', null, 'a user cannot create an org owned by someone else');

select * from finish();
rollback;
