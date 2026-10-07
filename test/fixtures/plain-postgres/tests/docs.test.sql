begin;
select plan(8);

-- Rows changed by a statement, without needing a data-modifying CTE.
create function pg_temp.changed(stmt text) returns int language plpgsql as
$$ declare n int; begin execute stmt; get diagnostics n = row_count; return n; end $$;

insert into docs (tenant_id, title, archived) values ('t1', 'mine', false), ('t1', 'mine archived', true), ('t2', 'theirs', false);
insert into plain_notes (tenant_id, body) values ('t1', 'a'), ('t2', 'b');

set local role app_user;
select set_config('app.tenant_id', 't1', true) as tenant \gset

select is((select count(*)::int from docs), 2, 'a tenant sees only its own docs');
select is((select count(*)::int from docs where tenant_id = 't2'), 0, 'a tenant cannot see another tenant''s docs');
select throws_ok($$insert into docs (tenant_id, title) values ('t2', 'planted')$$, '42501', null, 'cannot insert into another tenant');
select lives_ok($$insert into docs (tenant_id, title) values ('t1', 'new')$$, 'can insert into own tenant');

select is(pg_temp.changed($$update docs set title = 'edited' where title = 'mine'$$), 1, 'can update a live doc');
select is(pg_temp.changed($$update docs set title = 'x' where tenant_id = 't2'$$), 0, 'cannot update another tenant''s doc');
select is(pg_temp.changed($$update docs set title = 'x' where archived$$), 0, 'cannot update an archived doc');

select is((select count(*)::int from plain_notes), 1, 'a tenant sees only its own notes');

select * from finish();
rollback;
