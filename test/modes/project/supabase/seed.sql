insert into public.people (email, full_name, tenant_id, passport_no, token, note) values
  ('seed-one@example.test', 'Seed One', 't1', 111111, '11111111-1111-1111-1111-111111111111', 'seed note one'),
  ('seed-two@example.test', 'Seed Two', 't1', 222222, '22222222-2222-2222-2222-222222222222', null),
  ('seed-three@example.test', 'Seed Three', 't2', 333333, null, 'seed note three');
insert into public.orders (tenant_id, buyer_email, total) values
  ('t1', 'seed-one@example.test', 10), ('t2', 'seed-three@example.test', 30);
