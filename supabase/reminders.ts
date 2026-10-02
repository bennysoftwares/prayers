// Prayer Tracker – "reminders" Edge Function.
// Runs every minute (started by the Cron job in setup.sql). For every phone that turned on reminders,
// it checks that person's prayer times in their own time zone and sends a push message when a prayer
// is due and not yet marked as prayed. Nothing to fill in: keys are created and stored on the first run.
// It reaches the database through the normal web API (functions in fix-reminders.sql), and every call
// needs the secret code that the every-minute job sends.
import webpush from 'npm:web-push@3.6.7';

const API = Deno.env.get('SUPABASE_URL') || 'https://eoszbelrtxteaverzvus.supabase.co';
const PUBLIC_KEY = 'sb_publishable_exkQgHMBU0091L715c3IoQ_tAox8a_N';   // the same public key the app uses
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${API}/rest/v1/rpc/${name}`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const SUBJECT = 'https://eoszbelrtxteaverzvus.supabase.co';   // who sends the reminders (required by Apple)
const WINDOW = 10;               // minutes after a prayer's time in which its reminder may still go out
const SILENT_IDS = ['morning'];  // banner only

type Prayer = { id: string; name: string; time: string; notify?: boolean };

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
async function send(secret: string, row: any, payload: object) {
  try {
    await webpush.sendNotification(row.sub, JSON.stringify(payload), { TTL: 1800, urgency: 'high' });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await rpc('reminders_sub', { secret, endpoint: row.endpoint, action: 'drop' });  // phone unsubscribed
    else console.error('push failed', e?.statusCode, e?.body || e?.message);
    return false;
  }
}

Deno.serve(async (req) => {
  const secret = req.headers.get('x-cron-secret') || '';
  let all: any;
  try { all = await rpc('reminders_fetch', { secret }); }
  catch (e) { console.error(String(e)); return new Response('Not allowed', { status: 401 }); }
  if (!all.vapid_public) {                                // first run: create this server's own key pair
    const k = webpush.generateVAPIDKeys();
    await rpc('reminders_set_keys', { secret, pub: k.publicKey, priv: k.privateKey });
    all = await rpc('reminders_fetch', { secret });
  }
  webpush.setVapidDetails(SUBJECT, all.vapid_public, all.vapid_private);

  const byUser = new Map<string, any[]>();
  for (const r of all.subs) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r]);

  let sent = 0;
  const jobs: Promise<unknown>[] = [];
  for (const [uid, subs] of byUser) {
    // "Send a test notification" button in the app
    for (const r of subs) if (r.test_at) jobs.push((async () => {
      await rpc('reminders_sub', { secret, endpoint: r.endpoint, action: 'tested' });
      if (Date.now() - new Date(r.test_at).getTime() < 15 * 60000 && await send(secret, r, {
        title: 'Reminders are working ✓', body: 'This came from your account, so prayer reminders arrive even when the app is closed.',
        tag: 'prayer-test',
      })) sent++;
    })());
    for (const d of dueReminders(subs[0].data)) jobs.push((async () => {
      // remember it first, so the same reminder is never sent twice
      if (!await rpc('reminders_claim', { secret, uid, day: d.key, prayer: d.id })) return;
      const ok = (await Promise.all(subs.map((r) => send(secret, r, d.payload)))).filter(Boolean).length;
      sent += ok;
      if (!ok) await rpc('reminders_unclaim', { secret, uid, day: d.key, prayer: d.id });   // try again next minute
    })());
  }
  const results = await Promise.allSettled(jobs);
  for (const x of results) if (x.status === 'rejected') console.error(String(x.reason));
  return Response.json({ phones: all.subs.length, sent });
});
