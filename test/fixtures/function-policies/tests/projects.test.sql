begin;
select plan(3);

insert into members values (1, 'alice'), (2, 'bob');
insert into projects (org_id, name) values (1, 'alpha'), (2, 'beta');

set local role authenticated;
set local app.who = 'alice';

select is((select count(*)::int from projects), 1, 'a member sees only their org''s projects');
select is((select name from projects), 'alpha', 'and it is the right project');
select is((select count(*)::int from projects where org_id = 2), 0, 'not another org''s');

select * from finish();
rollback;
