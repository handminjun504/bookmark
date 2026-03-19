alter table if exists users
  add column if not exists subteam_name text;

create index if not exists idx_users_subteam_name on users(subteam_name);
