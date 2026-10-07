-- Quoted mixed-case and spaced names, a policy name holding quotes and a slash, and a table in a
-- non-public schema that is only covered when --schemas names it.
create extension pgtap;

create role authenticated nologin;
create schema auth;
grant usage on schema auth to authenticated;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema public to authenticated;
create schema "Odd Schema";
grant usage on schema "Odd Schema" to authenticated;

create table public."Mixed Case Docs" (
  "Doc Id" serial primary key,
  "Owner Id" uuid not null,
  "Backup Owner" uuid,
  "OrgName" text not null,
  "Title" text
);
create table "Odd Schema"."Line Items" (
  "Item Id" serial primary key,
  "Tenant Key" text not null,
  "Qty" int
);
grant select, insert, update on public."Mixed Case Docs" to authenticated;
grant select, update on "Odd Schema"."Line Items" to authenticated;
grant usage on all sequences in schema public to authenticated;

alter table public."Mixed Case Docs" enable row level security;
alter table "Odd Schema"."Line Items" enable row level security;

create policy "owner's ""quoted"" policy" on public."Mixed Case Docs" for select to authenticated
  using ("Owner Id" = auth.uid());
create policy "insert/own docs in org" on public."Mixed Case Docs" for insert to authenticated
  with check ("Owner Id" = auth.uid() and "OrgName" = current_setting('app.org', true));
create policy "tenant sees line items" on "Odd Schema"."Line Items" for select to authenticated
  using ("Tenant Key" = current_setting('app.org', true));
create policy "tenant edits line items" on "Odd Schema"."Line Items" for update to authenticated
  using ("Tenant Key" = current_setting('app.org', true))
  with check ("Tenant Key" = current_setting('app.org', true));
