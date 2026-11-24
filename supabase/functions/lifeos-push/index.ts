// LifeOS push notifications.
// Called every 5 minutes by pg_cron (header x-cron-secret), and by the app
// for a test push (Authorization: Bearer <user access token>, body {test:true}).
// Reads each user's synced LifeOS rows:
//   notifs          -> [{id, text, time:'HH:MM', days:[0-6], date:'YYYY-MM-DD', on}]
//   pushSubs        -> {deviceId: PushSubscription JSON}
//   pushCfg         -> {rem:true}  (also ping reminders that have a time)
//   reminders#<id>  -> {id, title, date, time, done}
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const TZ = "Pacific/Auckland";
const WINDOW_MIN = 12;

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

function nzNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    mins: Number(p.hour) * 60 + Number(p.minute),
    dow: days.indexOf(String(p.weekday).slice(0, 3)),
  };
}
const toMins = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

async function config() {
  const { data, error } = await sb.from("lifeos_push_config").select("k,v");
  if (error) throw error;
  return Object.fromEntries((data || []).map((r: { k: string; v: string }) => [r.k, r.v]));
}

async function rowsFor(keys: string[], userId?: string) {
  let q = sb.from("lifeos_rows").select("user_id,key,value").in("key", keys).eq("deleted", false);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function sendAll(subs: Record<string, unknown>, payload: Record<string, unknown>) {
  let ok = 0, fail = 0;
  for (const sub of Object.values(subs || {})) {
    if (!sub || typeof sub !== "object" || !(sub as { endpoint?: string }).endpoint) continue;
    try {
      await webpush.sendNotification(sub as webpush.PushSubscription, JSON.stringify(payload), { TTL: 3600 });
      ok++;
    } catch (e) {
      fail++;
      console.error("push failed", (e as { statusCode?: number }).statusCode, String(e).slice(0, 200));
    }
  }
  return { ok, fail };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const cfg = await config();
    webpush.setVapidDetails(cfg.subject || "mailto:lifeos@example.com", cfg.vapid_public, cfg.vapid_private);
    const body = await req.json().catch(() => ({}));

    // ---- test push from the app ----
    if (body && body.test) {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u, error } = await sb.auth.getUser(token);
      if (error || !u?.user) return json({ error: "Sign in to sync first" }, 401);
      const rows = await rowsFor(["pushSubs"], u.user.id);
      const subs = rows[0]?.value?.v || {};
      if (!Object.keys(subs).length) return json({ error: "No device is set up for notifications yet" }, 400);
      const r = await sendAll(subs, { title: "LifeOS", body: "Test notification. You're all set ✓", tag: "lifeos-test" });
      return json(r);
    }

    // ---- scheduled run ----
    if (!cfg.cron_secret || req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ error: "forbidden" }, 403);
    const now = nzNow();
    const due = (t: string) => {
      const m = toMins(t);
      return m >= 0 && m <= now.mins && now.mins - m < WINDOW_MIN;
    };

    const rows = await rowsFor(["notifs", "pushSubs", "pushCfg"]);
    const users = new Map<string, { notifs?: unknown[]; subs?: Record<string, unknown>; cfg?: { rem?: boolean } }>();
    for (const r of rows) {
      const u = users.get(r.user_id) || {};
      const v = r.value?.v;
      if (r.key === "notifs") u.notifs = Array.isArray(v) ? v : [];
      if (r.key === "pushSubs") u.subs = v && typeof v === "object" ? v : {};
      if (r.key === "pushCfg") u.cfg = v && typeof v === "object" ? v : {};
      users.set(r.user_id, u);
    }

    let sent = 0;
    for (const [userId, u] of users) {
      if (!u.subs || !Object.keys(u.subs).length) continue;
      const out: { id: string; title: string; body: string }[] = [];

      for (const n of (u.notifs || []) as Record<string, unknown>[]) {
        if (!n || n.on === false || !n.id || !due(String(n.time || ""))) continue;
        const date = String(n.date || "");
        const days = Array.isArray(n.days) ? (n.days as number[]) : [];
        const today = date ? date === now.date : days.length ? days.includes(now.dow) : true;
        if (!today) continue;
        out.push({ id: "n:" + n.id, title: String(n.title || "LifeOS"), body: String(n.text || "") });
      }

      if (u.cfg && u.cfg.rem) {
        const { data: rem } = await sb.from("lifeos_rows").select("key,value").eq("user_id", userId)
          .eq("deleted", false).like("key", "reminders#%");
        for (const r of rem || []) {
          const x = r.value?.v;
          if (!x || x.done || x.dismissed || x.date !== now.date || !x.time || !due(x.time)) continue;
          out.push({ id: "r:" + x.id, title: "🔔 Reminder", body: String(x.title || "") });
        }
      }

      for (const o of out) {
        const { error } = await sb.from("lifeos_push_sent").insert({ user_id: userId, notif_id: o.id, slot: now.date });
        if (error) continue; // already sent today
        const r = await sendAll(u.subs, { title: o.title, body: o.body, tag: o.id });
        sent += r.ok;
      }
    }
    return json({ at: now, sent });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
