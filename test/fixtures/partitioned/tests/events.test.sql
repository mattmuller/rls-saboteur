begin;
select plan(5);

insert into events values (1, 't1', 'login'), (2, 't2', 'login'), (3, 't1', 'billing'), (4, 't2', 'billing'), (5, 't1', 'misc');

set local role app_user;
set local app.tenant = 't1';

select is((select count(*)::int from events), 3, 'parent query returns only this tenant''s events, across partitions');
select throws_ok($$insert into events values (9, 't2', 'login')$$, '42501', null, 'cannot insert another tenant''s event through the parent');
select lives_ok($$insert into events values (10, 't1', 'login')$$, 'can insert this tenant''s event through the parent');
select is((select count(*)::int from events_billing), 1, 'a direct query on a partition is filtered by the partition''s policy');
select is((select count(*)::int from events_login), 3, 'a partition without RLS of its own returns every row when queried directly');

select * from finish();
rollback;
