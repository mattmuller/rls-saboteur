begin;
select plan(9);

create function pg_temp.changed(stmt text) returns int language plpgsql as
$$ declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;

insert into profiles (id, user_id, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'alice'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'bob');
insert into todos (owner_id, assignee_id, title) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'alice todo'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'bob todo');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';

select is((select count(*)::int from todos), 1, 'a user sees only their own todos');
select is((select title from todos), 'alice todo', 'and it is the right one');
select throws_ok($$insert into todos (owner_id, title) values ('00000000-0000-0000-0000-0000000000b2', 'planted')$$, '42501', null, 'cannot create a todo for someone else');
select lives_ok($$insert into todos (owner_id, title) values ('00000000-0000-0000-0000-0000000000a1', 'mine')$$, 'can create own todo');
select is((select count(*)::int from profiles), 2, 'profiles are readable by any signed-in user');
select is(pg_temp.changed($$update profiles set display_name = 'x' where user_id = '00000000-0000-0000-0000-0000000000b2'$$), 0, 'cannot edit another profile');
select is(pg_temp.changed($$update profiles set display_name = 'alice 2' where user_id = '00000000-0000-0000-0000-0000000000a1'$$), 1, 'can edit own profile');

reset role;
set local role anon;
select is((select count(*)::int from profiles), 2, 'anon reads profiles');
select throws_ok($$select count(*) from todos$$, '42501', null, 'anon has no grant on todos');

select * from finish();
rollback;
