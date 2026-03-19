alter table if exists clients
  add column if not exists client_code text,
  add column if not exists company_contact_name text,
  add column if not exists business_number text,
  add column if not exists ceo_name text,
  add column if not exists gyeongli_id text,
  add column if not exists gyeongli_pw_encrypted text,
  add column if not exists sheet_row_number integer,
  add column if not exists sheet_extra_fields jsonb not null default '{}'::jsonb,
  add column if not exists source_active boolean not null default true,
  add column if not exists hidden_local boolean not null default false,
  add column if not exists hidden_local_at timestamptz,
  add column if not exists last_synced_at timestamptz;

create unique index if not exists idx_clients_client_code_unique
  on clients(client_code)
  where client_code is not null and btrim(client_code) <> '';

create index if not exists idx_clients_source_active on clients(source_active);
create index if not exists idx_clients_hidden_local on clients(hidden_local);
create index if not exists idx_clients_sheet_row_number on clients(sheet_row_number);
