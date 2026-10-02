-- Prayer Tracker: reminders that arrive even when the app is closed.
-- Run this whole file once in Supabase › SQL Editor (after creating the "reminders" Edge Function).
-- Then also run fix-reminders.sql.
-- Safe to run again.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) Each phone that allows notifications is stored here (one row per phone)
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  sub        jsonb not null,
  test_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "own phones: select" on public.push_subs;
drop policy if exists "own phones: insert" on public.push_subs;
drop policy if exists "own phones: update" on public.push_subs;
drop policy if exists "own phones: delete" on public.push_subs;
create policy "own phones: select" on public.push_subs for select to authenticated using ((select auth.uid()) = user_id);
create policy "own phones: insert" on public.push_subs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own phones: update" on public.push_subs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own phones: delete" on public.push_subs for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.push_subs from anon;
grant select, insert, update, delete on public.push_subs to authenticated;

-- 2) Private settings (not reachable from the app or the internet)
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.push_config (
  id            int primary key default 1 check (id = 1),
  cron_secret   text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  vapid_public  text,
  vapid_private text
);
insert into private.push_config (id) values (1) on conflict do nothing;
create table if not exists private.push_sent (
  user_id uuid not null, day text not null, prayer text not null, sent_at timestamptz not null default now(),
  primary key (user_id, day, prayer)
);

-- 3) The app asks for the server's public key with this
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select vapid_public from private.push_config where id = 1
$$;
revoke all on function public.push_public_key() from public, anon;
grant execute on function public.push_public_key() to authenticated;

-- 4) Check for due reminders every minute
select cron.unschedule('prayer-reminders') where exists (select 1 from cron.job where jobname = 'prayer-reminders');
select cron.schedule('prayer-reminders', '* * * * *', $job$
  select net.http_post(
    url     := 'https://eoszbelrtxteaverzvus.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select cron_secret from private.push_config where id = 1)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000)
$job$);
