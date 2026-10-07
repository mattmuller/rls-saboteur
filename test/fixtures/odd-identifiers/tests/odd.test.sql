begin;
select plan(5);

insert into public."Mixed Case Docs" ("Owner Id", "Backup Owner", "OrgName", "Title") values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'o1', 'mine'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'o1', 'theirs');
insert into "Odd Schema"."Line Items" ("Tenant Key", "Qty") values ('o1', 1), ('o2', 2);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
set local app.org = 'o1';

select is((select count(*)::int from public."Mixed Case Docs"), 1, 'sees only own docs');
select is((select "Title" from public."Mixed Case Docs"), 'mine', 'the right doc');
select throws_ok($$insert into public."Mixed Case Docs" ("Owner Id", "OrgName") values ('00000000-0000-0000-0000-0000000000b2', 'o1')$$, '42501', null, 'cannot insert for another owner');
select is((select count(*)::int from "Odd Schema"."Line Items"), 1, 'sees only own tenant line items');
select is((select "Qty" from "Odd Schema"."Line Items"), 1, 'the right line item');

select * from finish();
rollback;
