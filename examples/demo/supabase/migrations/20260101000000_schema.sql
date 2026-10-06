-- A small multi-tenant app: orgs, members, documents, invoices.

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null
);

create table public.members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('member', 'admin', 'owner')),
  primary key (org_id, user_id)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  author_id uuid not null,
  title text not null,
  archived boolean not null default false
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  issued_by uuid not null,
  amount_cents integer not null,
  paid boolean not null default false
);

-- Is the signed-in user an admin or owner of the org?
create function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.org_id = target_org
      and m.user_id = auth.uid()
      and m.role in ('admin', 'owner')
  );
$$;

grant execute on function public.is_org_admin(uuid) to authenticated;
revoke execute on function public.is_org_admin(uuid) from public, anon;

alter table public.orgs enable row level security;
alter table public.members enable row level security;
alter table public.documents enable row level security;
alter table public.invoices enable row level security;

grant select, insert, update, delete on public.orgs, public.members, public.documents, public.invoices to authenticated;

-- orgs
create policy "members read their orgs" on public.orgs
  for select to authenticated
  using (id in (select org_id from public.members where user_id = auth.uid()));

create policy "anyone creates an org they own" on public.orgs
  for insert to authenticated
  with check (created_by = auth.uid());

-- members
create policy "members read co-members" on public.members
  for select to authenticated
  using (org_id in (select m.org_id from public.members m where m.user_id = auth.uid()));

create policy "admins manage members" on public.members
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- documents
create policy "members read documents" on public.documents
  for select to authenticated
  using (org_id in (select org_id from public.members where user_id = auth.uid()));

create policy "members write own documents" on public.documents
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and org_id in (select org_id from public.members where user_id = auth.uid())
  );

create policy "authors update own documents" on public.documents
  for update to authenticated
  using (author_id = auth.uid())
  with check (
    author_id = auth.uid()
    and org_id in (select org_id from public.members where user_id = auth.uid())
  );

create policy "authors delete own documents" on public.documents
  for delete to authenticated
  using (author_id = auth.uid());

-- Archived documents are hidden from everyone, whatever else allows them.
create policy "hide archived documents" on public.documents
  as restrictive
  for select to authenticated
  using (archived = false);

-- invoices
create policy "admins read invoices" on public.invoices
  for select to authenticated
  using (public.is_org_admin(org_id));

create policy "admins create invoices" on public.invoices
  for insert to authenticated
  with check (public.is_org_admin(org_id) and issued_by = auth.uid());

create policy "admins update invoices" on public.invoices
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
