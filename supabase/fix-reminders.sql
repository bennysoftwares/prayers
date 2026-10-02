-- Prayer Tracker: reminder server, part 2.
-- Lets the "reminders" function reach the database through the normal web API (like the app does).
-- Each of these only works with the secret code that the every-minute job sends. Safe to run again.

create or replace function private.reminders_check(secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if secret is null or secret is distinct from (select cron_secret from private.push_config where id = 1) then
    raise exception 'not allowed';
  end if;
end $$;

-- Everything the function needs for one run: keys, phones, and each person's settings + recent days
create or replace function public.reminders_fetch(secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  perform private.reminders_check(secret);
  delete from private.push_sent where sent_at < now() - interval '3 days';
  select * into c from private.push_config where id = 1;
  return jsonb_build_object(
    'vapid_public', c.vapid_public, 'vapid_private', c.vapid_private,
    'subs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'endpoint', s.endpoint, 'sub', s.sub, 'user_id', s.user_id, 'test_at', s.test_at,
        'data', jsonb_build_object(
          'settings', d.data -> 'settings',
          'days', coalesce((select jsonb_object_agg(k, v) from jsonb_each(d.data -> 'days') as e(k, v)
                            where k >= to_char(now() - interval '2 days', 'YYYY-MM-DD')), '{}'::jsonb))))
      from public.push_subs s left join public.user_data d on d.user_id = s.user_id), '[]'::jsonb));
end $$;

create or replace function public.reminders_set_keys(secret text, pub text, priv text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.reminders_check(secret);
  update private.push_config set vapid_public = pub, vapid_private = priv where id = 1 and vapid_public is null;
end $$;

-- true = this reminder hasn't been sent yet (and is now marked as sent)
create or replace function public.reminders_claim(secret text, uid uuid, day text, prayer text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.reminders_check(secret);
  insert into private.push_sent (user_id, day, prayer) values (uid, day, prayer) on conflict do nothing;
  return found;
end $$;

create or replace function public.reminders_unclaim(secret text, uid uuid, day text, prayer text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.reminders_check(secret);
  delete from private.push_sent p where p.user_id = uid and p.day = reminders_unclaim.day and p.prayer = reminders_unclaim.prayer;
end $$;

-- 'drop' = the phone no longer accepts reminders; 'tested' = the test was handled
create or replace function public.reminders_sub(secret text, endpoint text, action text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.reminders_check(secret);
  if action = 'drop' then delete from public.push_subs s where s.endpoint = reminders_sub.endpoint;
  else update public.push_subs s set test_at = null where s.endpoint = reminders_sub.endpoint; end if;
end $$;

revoke all on function private.reminders_check(text) from public, anon, authenticated;
revoke all on function public.reminders_fetch(text) from public;
revoke all on function public.reminders_set_keys(text, text, text) from public;
revoke all on function public.reminders_claim(text, uuid, text, text) from public;
revoke all on function public.reminders_unclaim(text, uuid, text, text) from public;
revoke all on function public.reminders_sub(text, text, text) from public;
grant execute on function public.reminders_fetch(text) to anon;
grant execute on function public.reminders_set_keys(text, text, text) to anon;
grant execute on function public.reminders_claim(text, uuid, text, text) to anon;
grant execute on function public.reminders_unclaim(text, uuid, text, text) to anon;
grant execute on function public.reminders_sub(text, text, text) to anon;
