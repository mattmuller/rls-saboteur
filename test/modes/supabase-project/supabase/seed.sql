-- Fake users and data. Nothing here is real.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'seed-ann@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'seed-ben@example.test');
insert into public.orgs (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'Seed Org One'),
  ('10000000-0000-0000-0000-000000000002', 'Seed Org Two');
insert into public.members (org_id, user_id) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2');
insert into public.documents (org_id, author_id, title, body) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'Seed doc A', 'seed body a'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2', 'Seed doc B', 'seed body b');
