alter table if exists clients
  add column if not exists client_category text not null default 'general',
  add column if not exists approval_number text,
  add column if not exists incorporation_registry_date date,
  add column if not exists fund_corporate_name text,
  add column if not exists parent_company_name text;

update clients
set client_category = 'general'
where client_category is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_client_category_check'
  ) then
    alter table clients
      add constraint clients_client_category_check
      check (client_category in ('general', 'welfare_fund', 'loan'));
  end if;
end $$;

create index if not exists idx_clients_client_category on clients(client_category);
