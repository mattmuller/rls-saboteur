-- Plain SQL, no pgTAP. Any failed expectation raises, psql stops with exit 3. The --test command maps 3 to 1 (a test failed), because the contract treats other codes as errors.
begin;

create function pg_temp.expect(label text, got int, want int) returns void language plpgsql as
$$ begin if got is distinct from want then raise exception 'FAIL: % (got %, want %)', label, got, want; end if; end $$;
create function pg_temp.denied(stmt text) returns int language plpgsql as
$$ begin execute stmt; return 0; exception when insufficient_privilege then return 1; end $$;

insert into records (org, locked, secret) values
  ('o1', false, false), ('o1', false, true), ('o1', true, false), ('o2', false, false);

set local role r_reader;
set local app.org = 'o1';
select pg_temp.expect('reader sees one open, non-secret record', (select count(*)::int from records), 1);

reset role;
set local role r_writer;
set local app.org = 'o1';
select pg_temp.expect('writer sees open records of its org, secrets included', (select count(*)::int from records), 2);
select pg_temp.expect('writer cannot see another org', (select count(*)::int from records where org = 'o2'), 0);
select pg_temp.expect('writer cannot insert into another org', pg_temp.denied($$insert into records (org) values ('o2')$$), 1);
select pg_temp.expect('writer can insert into its own org', pg_temp.denied($$insert into records (org) values ('o1')$$), 0);

reset role;
insert into ledger (who, amount) values ('me', 5), ('them', 7);
set local role r_writer;
set local app.who = 'me';
select pg_temp.expect('writer sees its own ledger rows', (select count(*)::int from ledger where who = 'me'), 1);

rollback;
