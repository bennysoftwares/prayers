// Prayer Tracker – "reminders" Edge Function.
// Runs every minute (started by the Cron job in setup.sql). For every phone that turned on reminders,
// it checks that person's prayer times in their own time zone and sends a push message when a prayer
// is due and not yet marked as prayed. Nothing to fill in: keys are created and stored on the first run.
import webpush from 'npm:web-push@3.6.7';
import postgres from 'npm:postgres@3.4.5';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });
const SUBJECT = Deno.env.get('SUPABASE_URL') || 'https://supabase.com';
const WINDOW = 10;               // minutes after a prayer's time in which its reminder may still go out
const SILENT_IDS = ['morning'];  // banner only

type Prayer = { id: string; name: string; time: string; notify?: boolean };

// ---------- Settings / keys ----------
async function config() {
  let [c] = await sql`select cron_secret, vapid_public, vapid_private from private.push_config where id = 1`;
  if (c && !c.vapid_public) {                             // first run: create this server's own key pair
    const k = webpush.generateVAPIDKeys();
    await sql`update private.push_config set vapid_public = ${k.publicKey}, vapid_private = ${k.privateKey}
              where id = 1 and vapid_public is null`;
    [c] = await sql`select cron_secret, vapid_public, vapid_private from private.push_config where id = 1`;
  }
  return c;
}

// ---------- Time helpers (same maths as the app) ----------
function validTz(tz?: string) {
  try { if (tz) { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } } catch (_) { /* fall through */ }
  return 'Europe/Stockholm';
}
function localNow(tz: string, date = new Date()) {
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)) o[p.type] = p.value;
  return { key: `${o.year}-${o.month}-${o.day}`, min: ((+o.hour) % 24) * 60 + (+o.minute) };
}
const toMin = (t: string) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
function sunsetTime(key: string, lat: number, lon: number, tz: string): string | null {
  const rad = Math.PI / 180, [y, m, d] = key.split('-').map(Number);
  const n = Math.round(Date.UTC(y, m - 1, d, 12) / 864e5 + 2440587.5 - 2451545.0 + 0.0008);
  const Js = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lam = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
  const dec = Math.asin(Math.sin(lam * rad) * Math.sin(23.4397 * rad));
  const cosw = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (cosw < -1 || cosw > 1) return null;
  const when = new Date((Jt + Math.acos(cosw) / rad / 360 - 2440587.5) * 864e5);
  const t = localNow(tz, when).min;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// Which reminders are due right now for one person's data
export function dueReminders(data: any, date = new Date()) {
  const S = data?.settings || {};
  const prayers: Prayer[] = (S.customOn && S.custom?.length ? S.custom : S.prayers) || [];
  const L = S.location || {}, tz = validTz(L.tz), now = localNow(tz, date);
  const done = data?.days?.[now.key]?.done || {};
  const count = prayers.filter((p) => done[p.id]).length;
  const out = [];
  for (const p of prayers) {
    if (!p.notify || done[p.id]) continue;
    let time = p.time;
    if (p.id === 'sunset' && S.autoSunset && L.lat != null && L.lon != null) time = sunsetTime(now.key, L.lat, L.lon, tz) || time;
    const t = toMin(time);
    if (now.min >= t && now.min < t + WINDOW) out.push({
      key: now.key, id: p.id,
      payload: {
        title: `It’s time for ${p.name} prayer${L.flag ? ' ' + L.flag : ''}`,
        body: `${count} of ${prayers.length} prayed – mark ${p.name} ✓`,
        tag: 'prayer-' + p.id, prayer: p.id, silent: SILENT_IDS.includes(p.id),
      },
    });
  }
  return out;
}

// ---------- Sending ----------
async function send(row: any, payload: object) {
  try {
    await webpush.sendNotification(row.sub, JSON.stringify(payload), { TTL: 1800, urgency: 'high' });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from public.push_subs where endpoint = ${row.endpoint}`;  // phone unsubscribed
    else console.error('push failed', e?.statusCode, e?.body || e?.message);
    return false;
  }
}

Deno.serve(async (req) => {
  const c = await config();
  if (!c || req.headers.get('x-cron-secret') !== c.cron_secret) return new Response('Not allowed', { status: 401 });
  webpush.setVapidDetails(SUBJECT, c.vapid_public, c.vapid_private);

  const rows = await sql`select s.endpoint, s.sub, s.user_id, s.test_at, d.data
    from public.push_subs s left join public.user_data d on d.user_id = s.user_id`;
  const byUser = new Map<string, any[]>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r]);

  let sent = 0;
  const jobs: Promise<unknown>[] = [];
  for (const [userId, subs] of byUser) {
    // "Send a test" button in the app
    for (const r of subs) if (r.test_at) jobs.push((async () => {
      await sql`update public.push_subs set test_at = null where endpoint = ${r.endpoint}`;
      if (Date.now() - new Date(r.test_at).getTime() < 15 * 60000 && await send(r, {
        title: 'Reminders are working ✓', body: 'This came from your account, so prayer reminders arrive even when the app is closed.',
        tag: 'prayer-test',
      })) sent++;
    })());
    for (const d of dueReminders(subs[0].data)) jobs.push((async () => {
      // remember it first, so the same reminder is never sent twice
      const claimed = await sql`insert into private.push_sent (user_id, day, prayer) values (${userId}, ${d.key}, ${d.id})
                                on conflict do nothing returning 1`;
      if (!claimed.length) return;
      const ok = (await Promise.all(subs.map((r) => send(r, d.payload)))).filter(Boolean).length;
      sent += ok;
      if (!ok) await sql`delete from private.push_sent where user_id = ${userId} and day = ${d.key} and prayer = ${d.id}`; // try again next minute
    })());
  }
  await Promise.all(jobs);
  await sql`delete from private.push_sent where sent_at < now() - interval '3 days'`;
  return Response.json({ phones: rows.length, sent });
});
