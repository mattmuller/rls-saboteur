-- RLS on a partitioned table and on its partitions. Postgres applies the policies of the table that
-- was named in the query: querying the parent uses the parent's policies, querying a partition
-- directly uses that partition's own. Each is covered separately here.
create extension pgtap;

create role app_user nologin;
grant usage on schema public to app_user;

create table events (
  id int not null,
  tenant text not null,
  kind text not null,
  primary key (id, kind)
) partition by list (kind);
create table events_login partition of events for values in ('login');
create table events_billing partition of events for values in ('billing');
create table events_other partition of events default;

grant select, insert on events, events_login, events_billing, events_other to app_user;

alter table events enable row level security;
alter table events_billing enable row level security;
alter table events_other enable row level security;

-- Parent policies: apply to queries on events.
create policy "tenant reads events" on events for select to app_user
  using (tenant = current_setting('app.tenant', true));
create policy "tenant writes events" on events for insert to app_user
  with check (tenant = current_setting('app.tenant', true));

-- Partition policies: apply only to queries that name the partition.
create policy "tenant reads billing" on events_billing for select to app_user
  using (tenant = current_setting('app.tenant', true));
create policy "tenant reads other" on events_other for select to app_user
  using (tenant = current_setting('app.tenant', true));
