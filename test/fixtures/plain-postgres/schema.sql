-- Plain Postgres: no auth schema, no anon or authenticated roles, no Supabase anywhere.
-- Tenancy comes from a session setting, and the roles are app_user and app_admin.
create extension pgtap;

create role app_owner login password 'owner';
create role app_user nologin;
create role app_admin nologin;
-- The owner switches into the roles inside tests.
grant app_user, app_admin to app_owner;
grant all on schema public to app_owner;

set session authorization app_owner;

create table docs (
  id serial primary key,
  tenant_id text not null,
  title text not null,
  archived boolean not null default false
);
create table audit_log (
  id serial primary key,
  tenant_id text not null,
  entry text not null
);
create table plain_notes (
  id serial primary key,
  tenant_id text not null,
  body text not null
);

grant select, insert, update, delete on docs, audit_log, plain_notes to app_user, app_admin;
grant usage on all sequences in schema public to app_user, app_admin;

alter table docs enable row level security;
alter table audit_log enable row level security;
alter table plain_notes enable row level security;

-- docs
create policy "tenant reads docs" on docs for select to app_user
  using (tenant_id = current_setting('app.tenant_id', true));
create policy "tenant inserts docs" on docs for insert to app_user
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy "tenant updates live docs" on docs for update to app_user
  using (tenant_id = current_setting('app.tenant_id', true) and not archived)
  with check (tenant_id = current_setting('app.tenant_id', true));
create policy "admin full access" on docs for all to app_admin
  using (true) with check (true);

-- audit_log: the tests never touch it, so every break on it is a deliberate miss.
create policy "tenant reads audit log" on audit_log for select to app_user
  using (tenant_id = current_setting('app.tenant_id', true));

-- plain_notes: only the SELECT policy is tested.
create policy "tenant reads notes" on plain_notes for select to app_user
  using (tenant_id = current_setting('app.tenant_id', true));
create policy "tenant deletes notes" on plain_notes for delete to app_user
  using (tenant_id = current_setting('app.tenant_id', true));

reset session authorization;
