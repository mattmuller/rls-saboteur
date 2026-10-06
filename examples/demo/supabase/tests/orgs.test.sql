begin;
select plan(2);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$insert into public.orgs (name, created_by) values ('Mine', '11111111-1111-1111-1111-111111111111')$$,
  'a user creates an org they own');
select throws_ok(
  $$insert into public.orgs (name, created_by) values ('Theirs', '22222222-2222-2222-2222-222222222222')$$,
  '42501', null, 'a user cannot create an org owned by someone else');

select * from finish();
rollback;
