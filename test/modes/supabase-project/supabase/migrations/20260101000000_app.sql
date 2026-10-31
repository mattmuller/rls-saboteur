-- A small Supabase-shaped app: tenants, members and documents, with auth.uid() policies.
create extension if not exists "uuid-ossp" with schema extensions;

create table public.orgs (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null
);
create table public.members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  primary key (org_id, user_id)
);
create table public.documents (
  id uuid primary key default extensions.uuid_generate_v4(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  author_id uuid not null references auth.users (id),
  title text not null,
  body text
);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.orgs, public.members, public.documents to authenticated;

alter table public.orgs enable row level security;
alter table public.members enable row level security;
alter table public.documents enable row level security;

create function public.is_member(org uuid) returns boolean language sql stable security definer set search_path = '' as
$$ select exists (select 1 from public.members m where m.org_id = org and m.user_id = auth.uid()) $$;
grant execute on function public.is_member(uuid) to authenticated;

create policy "members read their orgs" on public.orgs for select to authenticated using (public.is_member(id));
create policy "members read members" on public.members for select to authenticated using (public.is_member(org_id));
create policy "members read documents" on public.documents for select to authenticated using (public.is_member(org_id));
create policy "authors write documents" on public.documents for insert to authenticated
  with check (author_id = auth.uid() and public.is_member(org_id));
create policy "authors update own documents" on public.documents for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy "authors delete own documents" on public.documents for delete to authenticated
  using (author_id = auth.uid());
