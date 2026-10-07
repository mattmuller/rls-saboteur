-- RESTRICTIVE policies, FOR ALL, policies naming several roles, PUBLIC, and a permissive/restrictive
-- mix on one table. No pgTAP: the suite is one plain SQL script run with --test.
create role r_reader nologin;
create role r_writer nologin;

create table records (
  id serial primary key,
  org text not null,
  locked boolean not null default false,
  secret boolean not null default false
);
create table ledger (
  id serial primary key,
  who text not null,
  amount int not null
);
grant select on records, ledger to r_reader;
grant select, insert, update, delete on records to r_writer;
grant select on ledger to r_writer;
grant usage on all sequences in schema public to r_writer;

alter table records enable row level security;
alter table ledger enable row level security;

-- records: two permissive policies and two restrictive ones on the same table.
create policy "org members read" on records as permissive for select to r_reader, r_writer
  using (org = current_setting('app.org', true));
create policy "writers manage org" on records as permissive for all to r_writer
  using (org = current_setting('app.org', true)) with check (org = current_setting('app.org', true));
create policy "hide locked records" on records as restrictive for all to r_reader, r_writer
  using (not locked);
create policy "readers never see secrets" on records as restrictive for select to r_reader
  using (not secret);

-- ledger: permissive for everyone (PUBLIC), restrictive on top.
create policy "ledger visible" on ledger as permissive for select to public
  using (true);
create policy "ledger own rows only" on ledger as restrictive for select to public
  using (who = current_setting('app.who', true));
