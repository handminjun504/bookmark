alter table if exists clients
  add column if not exists status text not null default 'active',
  add column if not exists owner_name text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists last_contact_at date,
  add column if not exists next_action_title text,
  add column if not exists next_action_at date,
  add column if not exists sort_order integer default 0;

update clients
set status = 'active'
where status is null;

with ordered_clients as (
  select
    id,
    row_number() over (
      order by
        coalesce(sort_order, 2147483647),
        created_at nulls last,
        name
    ) - 1 as next_sort
  from clients
)
update clients
set sort_order = ordered_clients.next_sort
from ordered_clients
where clients.id = ordered_clients.id
  and clients.sort_order is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clients_status_check'
  ) then
    alter table clients
      add constraint clients_status_check
      check (status in ('active', 'pending', 'paused', 'closed'));
  end if;
end $$;

alter table if exists bookmarks
  add column if not exists client_id uuid references clients(id) on delete set null;

alter table if exists events
  add column if not exists client_id uuid references clients(id) on delete set null;

alter table if exists memos
  add column if not exists client_id uuid references clients(id) on delete set null;

create index if not exists idx_clients_sort_order on clients(sort_order);
create index if not exists idx_clients_status on clients(status);
create index if not exists idx_clients_next_action_at on clients(next_action_at);
create index if not exists idx_bookmarks_client_id on bookmarks(client_id);
create index if not exists idx_events_client_id on events(client_id);
create index if not exists idx_memos_client_id on memos(client_id);
