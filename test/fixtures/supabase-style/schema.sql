-- Supabase-shaped database without Supabase: a stub auth schema with auth.uid(), and the
-- anon, authenticated and service_role roles. Superuser owns everything, like the local CLI default.
create extension pgtap;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

create table profiles (
  id uuid primary key,
  user_id uuid not null,
  display_name text not null
);
create table todos (
  id serial primary key,
  owner_id uuid not null,
  assignee_id uuid,
  title text not null
);
create table shares (
  id serial primary key,
  todo_id int not null references todos (id),
  user_id uuid not null
);
grant select, insert, update, delete on profiles, todos, shares to authenticated;
grant select on profiles to anon;
grant usage on all sequences in schema public to authenticated;

alter table profiles enable row level security;
alter table todos enable row level security;
alter table shares enable row level security;

create policy "profiles are public" on profiles for select to anon, authenticated using (true);
create policy "users update own profile" on profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "owners and sharees read todos" on todos for select to authenticated
  using (owner_id = auth.uid() or exists (select 1 from shares s where s.todo_id = todos.id and s.user_id = auth.uid()));
create policy "owners insert todos" on todos for insert to authenticated
  with check (owner_id = auth.uid());
create policy "owners delete todos" on todos for delete to authenticated
  using (owner_id = auth.uid());

create policy "participants read shares" on shares for select to authenticated
  using (user_id = auth.uid());
