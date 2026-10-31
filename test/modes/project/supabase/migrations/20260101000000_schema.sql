-- Fixture for the build modes. Roles are created only when missing, so the same file works on a server that has them
-- and in a fresh container that does not.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'app_admin') then create role app_admin nologin; end if;
end $$;

create table public.people (
  id serial primary key,
  email text not null unique,
  full_name varchar(60) not null,
  tenant_id text not null,
  passport_no integer,
  token uuid,
  note text
);
create table public.orders (
  id serial primary key,
  tenant_id text not null,
  buyer_email text not null,
  total integer not null
);

grant usage on schema public to app_user, app_admin;
grant select, insert, update, delete on public.people, public.orders to app_user, app_admin;
grant usage on all sequences in schema public to app_user, app_admin;

alter table public.people enable row level security;
alter table public.orders enable row level security;

create policy "tenant reads people" on public.people for select to app_user
  using (tenant_id = current_setting('app.tenant_id', true));
create policy "admin full access to people" on public.people for all to app_admin
  using (true) with check (true);
create policy "tenant reads orders" on public.orders for select to app_user
  using (tenant_id = current_setting('app.tenant_id', true));
