alter table if exists events
  add column if not exists calendar_type text,
  add column if not exists team_id uuid references teams(id) on delete set null;

update events
set calendar_type = case
  when coalesce(is_task, false) then 'work'
  else 'personal'
end
where calendar_type is null;

update events
set calendar_type = 'personal'
where calendar_type not in ('personal', 'work');

update events as e
set team_id = u.team_id
from users as u
where e.user_id = u.id
  and e.team_id is null
  and e.calendar_type = 'work'
  and u.team_id is not null;

alter table if exists events
  alter column calendar_type set default 'personal';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'events_calendar_type_check'
  ) then
    alter table events
      add constraint events_calendar_type_check
      check (calendar_type in ('personal', 'work'));
  end if;
end $$;

create index if not exists idx_events_calendar_type on events(calendar_type);
create index if not exists idx_events_team_id on events(team_id);
create index if not exists idx_events_team_calendar_type on events(team_id, calendar_type);
