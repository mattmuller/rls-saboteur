-- A tiny test suite in plain SQL, so the end-to-end test needs no pgTAP.
-- It exits non-zero (raise exception) when an expectation fails.
begin;
insert into docs (id, org, owner) values (1, 'a', '11111111-1111-1111-1111-111111111111'), (2, 'b', '22222222-2222-2222-2222-222222222222');

set local role app_user;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);

do $$
begin
  -- Reads own org (catches: drop policy).
  if (select count(*) from docs) <> 1 then raise exception 'expected to read exactly the own document'; end if;
end $$;

do $$
begin
  -- Cannot forge the owner on insert (catches: WITH CHECK removed).
  begin
    insert into docs (id, org, owner) values (3, 'a', '22222222-2222-2222-2222-222222222222');
    raise exception 'forged insert was allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
