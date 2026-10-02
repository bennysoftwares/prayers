-- Prayer Tracker: make "Send a test notification" arrive within seconds.
-- The app calls this; it marks the phone for a test and starts the reminders server right away
-- (instead of waiting for the next minute). Safe to run again.
create or replace function public.push_test(ep text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.push_subs s set test_at = now()
   where s.endpoint = ep and s.user_id = auth.uid()
     and (s.test_at is null or s.test_at < now() - interval '20 seconds');   -- no more than one test per 20 s
  if not found then return; end if;
  perform net.http_post(
    url     := 'https://eoszbelrtxteaverzvus.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select cron_secret from private.push_config where id = 1)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000);
end $$;
revoke all on function public.push_test(text) from public, anon;
grant execute on function public.push_test(text) to authenticated;
