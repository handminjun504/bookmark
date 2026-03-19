create table if not exists user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  client_view_state jsonb not null default '{}'::jsonb,
  client_custom_view jsonb,
  url_notes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

update user_preferences
set client_view_state = '{}'::jsonb
where client_view_state is null;

update user_preferences
set url_notes = '{}'::jsonb
where url_notes is null;
