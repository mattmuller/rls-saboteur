begin;
select plan(12);

-- Fixtures: two orgs, one member each.
insert into public.orgs (id, name, created_by) values
  ('a0000000-0000-0000-0000-00000000000a', 'Acme',   '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-00000000000b', 'Bravo',  '22222222-2222-2222-2222-222222222222');
insert into public.members (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'member'),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'member');
insert into public.documents (id, org_id, author_id, title, archived) values
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Acme plan', false),
  ('d0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Old plan', true);

-- Sign in as the Acme member.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is((select count(*)::int from public.documents), 1, 'a member reads the documents of their own org');
select is((select count(*)::int from public.documents where archived), 0, 'archived documents stay hidden');

select lives_ok(
  $$insert into public.documents (org_id, author_id, title)
    values ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Notes')$$,
  'a member writes a document in their own org');

select throws_ok(
  $$insert into public.documents (org_id, author_id, title)
    values ('a0000000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'Forged')$$,
  '42501', null, 'a member cannot write a document as someone else');

select throws_ok(
  $$insert into public.documents (org_id, author_id, title)
    values ('b0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'Elsewhere')$$,
  '42501', null, 'a member cannot write a document into another org');

select lives_ok(
  $$update public.documents set title = 'Acme plan v2' where id = 'd0000000-0000-0000-0000-000000000001'$$,
  'an author updates their own document');
select is((select title from public.documents where id = 'd0000000-0000-0000-0000-000000000001'), 'Acme plan v2',
  'the update changed the title');

select throws_ok(
  $$update public.documents set org_id = 'b0000000-0000-0000-0000-00000000000b' where id = 'd0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'an author cannot move a document into another org');
select throws_ok(
  $$update public.documents set author_id = '22222222-2222-2222-2222-222222222222' where id = 'd0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'an author cannot hand a document to someone else');

select lives_ok(
  $$delete from public.documents where id = 'd0000000-0000-0000-0000-000000000001'$$,
  'an author deletes their own document');
select is((select count(*)::int from public.documents where id = 'd0000000-0000-0000-0000-000000000001'), 0,
  'the deleted document is gone');

-- Sign in as the Bravo member.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.documents where org_id = 'a0000000-0000-0000-0000-00000000000a'), 0,
  'a member of Bravo does not see Acme documents (after the delete)');

select * from finish();
rollback;
