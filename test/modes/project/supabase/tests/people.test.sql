begin;
select plan(3);
set local role app_user;
select set_config('app.tenant_id', 't1', true) as tenant \gset
select is((select count(*)::int from people), 2, 'a tenant sees only its own people');
select is((select count(*)::int from people where tenant_id = 't2'), 0, 'a tenant cannot see another tenant''s people');
select is((select count(*)::int from orders where tenant_id = 't1'), 1, 'a tenant sees its own orders');
select * from finish();
rollback;
