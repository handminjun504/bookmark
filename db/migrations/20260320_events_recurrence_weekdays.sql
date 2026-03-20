alter table if exists events
  add column if not exists recurrence_weekdays jsonb not null default '[]'::jsonb;

update events
set recurrence_weekdays = jsonb_build_array(
  case extract(isodow from start_date::date)
    when 1 then 'mon'
    when 2 then 'tue'
    when 3 then 'wed'
    when 4 then 'thu'
    when 5 then 'fri'
    when 6 then 'sat'
    when 7 then 'sun'
  end
)
where recurrence_type = 'weekly'
  and coalesce(recurrence_weekdays, '[]'::jsonb) = '[]'::jsonb;
