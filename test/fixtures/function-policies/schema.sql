-- Policies that call SECURITY DEFINER helpers. Two defects the catalogue checks must report without
-- any test running them:
--   1. archived_projects: the policy calls can_see_archive(), and its role cannot EXECUTE it.
--   2. settings: the policy calls is_admin_bad(), which tests current_user inside SECURITY DEFINER.
-- No test file touches either table. Calling a function as a role that lacks EXECUTE can crash the
-- backend on some Postgres builds, so this fixture never does.
create extension pgtap;

create role authenticated nologin;
create role anon nologin;
grant usage on schema public to authenticated, anon;

create schema private;
grant usage on schema private to authenticated;

create table members (org_id int not null, user_name text not null, primary key (org_id, user_name));
create table projects (id serial primary key, org_id int not null, name text not null);
create table archived_projects (id serial primary key, org_id int not null, name text not null);
create table settings (id serial primary key, org_id int not null, value text not null);
grant select, insert on projects to authenticated;
grant select on archived_projects, settings to authenticated;
grant usage on all sequences in schema public to authenticated;

-- Works: authenticated can execute it, and members is read inside a definer function.
create function private.is_member(org int) returns boolean language sql stable security definer
set search_path = public as
$$ select exists (select 1 from members m where m.org_id = org and m.user_name = current_setting('app.who', true)) $$;
revoke execute on function private.is_member(int) from public;
grant execute on function private.is_member(int) to authenticated;

-- Broken: nobody but the owner may execute it.
create function public.can_see_archive(org int) returns boolean language sql stable security definer
set search_path = public as
$$ select exists (select 1 from members m where m.org_id = org and m.user_name = current_setting('app.who', true)) $$;
revoke execute on function public.can_see_archive(int) from public;

-- Broken in a different way: current_user inside SECURITY DEFINER is the owner, never the caller.
create function public.is_admin_bad() returns boolean language plpgsql stable security definer
set search_path = public as
$$ begin return current_user = 'postgres'; end $$;
revoke execute on function public.is_admin_bad() from public;
grant execute on function public.is_admin_bad() to authenticated;

alter table members enable row level security;
alter table projects enable row level security;
alter table archived_projects enable row level security;
alter table settings enable row level security;

create policy "members read projects" on projects for select to authenticated
  using (private.is_member(org_id));
create policy "members insert projects" on projects for insert to authenticated
  with check (private.is_member(org_id));
create policy "archive readers" on archived_projects for select to authenticated
  using (can_see_archive(org_id));
create policy "admins read settings" on settings for select to authenticated
  using (is_admin_bad());
