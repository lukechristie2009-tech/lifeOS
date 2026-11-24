// LifeOS push notifications.
// Called every 5 minutes by pg_cron (header x-cron-secret), and by the app
// (Authorization: Bearer <user access token>) with {test:true|'morning'|'gym'}.
//
// Built-in notifications (each switchable in pushCfg, times in NZ time):
//   morning   05:30  discipline streak + today's workout with targets + a quote -> Dashboard
//   gym       5 min before the Gym task: gym days in a row + split + targets  -> Workout
//   tick      07:45 and 17:30 if there's anything left to tick               -> tick-off
//   evening   20:00  tick off what's left + write the daily review           -> tick-off / review
//   focus     16:00  Life / Ecom focus ends in 2 days, tomorrow, or today     -> Focus
//   missed    (off by default) a routine task still unticked N min after its time
//   rem       (off by default) reminders that have a time ping at that time
// Custom notifications (state.notifs): normal, or SOS that repeats every N min
// for H hours until marked done. A device in pushSubs with off:true gets nothing.
// 25 Nov: every notification is editable by holding it in the app:
//   built-ins -> pushCfg.over[key] = {title, text, go, apps}
//   custom    -> n.go, n.apps on the notification itself
// {auto} in a heading/message is swapped for what LifeOS would have said.
// Apps ride along in go as "page~appId,appId"; the app shows buttons for them.
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

// deno-lint-ignore no-explicit-any
type Any = Record<string, any>;
type Note = { id: string; title: string; body: string; go: string };

function nzNow() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute), dow: days.indexOf(String(p.weekday).slice(0, 3)) };
}
const toMins = (t: unknown) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};
const addDays = (ds: string, n: number) => {
  const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
const clean = (t: unknown) => String(t || "").replace(/\p{Extended_Pictographic}|️|‍/gu, "").replace(/\s+/g, " ").trim();
const kg = (n: number) => (Math.round(n * 100) / 100).toString();

const KEY_OF: Record<string, string> = { m: "morning", g: "gym", t: "tick", e: "evening", f: "focus", u: "missed", r: "rem" };
function withApps(go: string, apps: unknown) {
  const a = Array.isArray(apps) ? apps.filter((x) => typeof x === "string" && x).slice(0, 6) : [];
  return a.length ? `${go}~${a.join(",")}` : go;
}
function fill(tpl: unknown, auto: string) {
  const t = String(tpl || "").trim();
  if (!t) return auto;
  return t.includes("{auto}") ? t.replace(/\{auto\}/g, auto) : t;
}
/* apply the user's edits for a built-in notification */
function over(n: Note, cfg: Any): Note {
  const key = KEY_OF[n.id.split(":")[0]];
  const o = key && cfg?.over && typeof cfg.over === "object" ? cfg.over[key] : null;
  if (!o || typeof o !== "object") return n;
  const go = o.go && !/^sos:/.test(n.go) ? String(o.go) : n.go;
  return { ...n, title: fill(o.title, n.title), body: fill(o.text, n.body), go: withApps(go, o.apps) };
}

async function config() {
  const { data, error } = await sb.from("lifeos_push_config").select("k,v");
  if (error) throw error;
  return Object.fromEntries((data || []).map((r: { k: string; v: string }) => [r.k, r.v]));
}
// deno-lint-ignore no-explicit-any
async function rows(userId: string | null, filter: (q: any) => any) {
  let q = sb.from("lifeos_rows").select("user_id,key,value").eq("deleted", false);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await filter(q);
  if (error) throw error;
  return (data || []) as Any[];
}

async function sendAll(subs: Any, n: Note) {
  let ok = 0, fail = 0;
  const payload = JSON.stringify({ title: n.title, body: n.body, tag: n.id, url: "/?go=" + encodeURIComponent(n.go) });
  for (const sub of Object.values(subs || {})) {
    if (!sub || typeof sub !== "object" || !(sub as Any).endpoint || (sub as Any).off) continue;
    try {
      const { endpoint, keys } = sub as Any;
      await webpush.sendNotification({ endpoint, keys }, payload, { TTL: 3600, urgency: "high" });
      ok++;
    } catch (e) {
      fail++; console.error("push failed", (e as Any).statusCode, String(e).slice(0, 200));
    }
  }
  return { ok, fail };
}
/* iPhone sometimes holds a web push until the next one arrives. Sending the
   same notification again (same tag, so it only shows once) pushes it through. */
async function sendTwice(subs: Any, n: Note) {
  const r = await sendAll(subs, n);
  if (r.ok) { await new Promise((res) => setTimeout(res, 10000)); await sendAll(subs, n); }
  return r;
}

/* Everything about a user's day, loaded once per run */
async function loadDay(userId: string, date: string) {
  const r = await rows(userId, (q) => q.or(
    `key.like.lifeFocuses#%,key.like.ecommerceFocuses#%,key.eq.todaysLists#${date},key.eq.briefings,key.eq.daysOff,` +
    `key.like.reminders#%,key.eq.workout,key.eq.quotes,key.eq.dailyReviews#${date},key.eq.disciplineStreakStart`,
  ));
  const ctx: Any = { focuses: [], items: [], list: [], rems: [], remDone: new Set<string>(), brief: "", dayOff: false, workout: null, quotes: [], reviewed: false, streakStart: "", byDate: {} };
  for (const row of r) {
    const v = row.value?.v, k = row.key as string;
    if (v == null) continue;
    if (k.startsWith("todaysLists#")) ctx.list = Array.isArray(v.items) ? v.items : [];
    else if (k === "briefings") ctx.brief = String(v[date] || "").trim();
    else if (k === "daysOff") ctx.dayOff = (Array.isArray(v) ? v : []).some((d: Any) => d && d.startDate && d.startDate <= date && (d.endDate || d.startDate) >= date);
    else if (k.startsWith("reminders#")) {
      if (v.id && (v.done || v.dismissed)) ctx.remDone.add(String(v.id));
      else if (v.id && v.date === date) ctx.rems.push(v);
    }
    else if (k === "workout") ctx.workout = v;
    else if (k === "quotes") ctx.quotes = Array.isArray(v) ? v : [];
    else if (k.startsWith("dailyReviews#")) ctx.reviewed = !!v;
    else if (k === "disciplineStreakStart") ctx.streakStart = String(v || "");
    else if (k.includes("Focuses#") && Array.isArray(v.days)) {
      ctx.focuses.push({ kind: k.startsWith("life") ? "Life" : "Ecom", name: v.name || "", start: v.startDate || "", end: v.endDate || "" });
      for (const d of v.days) {
        if (!d || !d.date || !Array.isArray(d.items)) continue;
        (ctx.byDate[d.date] = ctx.byDate[d.date] || []).push(...d.items);
      }
    }
  }
  for (const d of Object.keys(ctx.byDate)) {
    const seen = new Set<string>();
    ctx.byDate[d] = ctx.byDate[d].filter((it: Any) => it && it.title && it.type !== "dropdown" && !seen.has(String(it.id)) && (seen.add(String(it.id)), true));
  }
  ctx.items = ctx.byDate[date] || [];
  return ctx;
}

function planFor(ctx: Any, dow: number) {
  const w = ctx.workout; if (!w || !w.week) return null;
  const id = w.week[String(dow)]; if (!id) return null;
  return (w.plans || []).find((p: Any) => p.id === id) || null;
}

async function loadLogs(userId: string, ctx: Any) {
  if (ctx.logs) return ctx.logs;
  ctx.logs = (await rows(userId, (q) => q.like("key", "workoutLog#%").neq("key", "workoutLog#~order")))
    .map((r) => r.value?.v).filter((l) => l && l.date && Array.isArray(l.ex))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return ctx.logs;
}
/* weights and reps to beat for today's split, from the last time each lift was logged */
function targetsFor(ctx: Any, plan: Any, today: string, max = 4) {
  const inc = Number(ctx.workout?.cfg?.inc) || 1.25;
  const out: string[] = [];
  for (const ex of plan.ex || []) {
    let best: Any = null;
    for (const l of ctx.logs || []) {
      if (l.date >= today) continue;
      const e = l.ex.find((x: Any) => x.exId === ex.id || clean(x.name) === clean(ex.name));
      const sets = e && Array.isArray(e.sets) ? e.sets.filter((s: Any) => s.done && Number(s.kg) >= 0 && Number(s.r) > 0) : [];
      if (!sets.length) continue;
      best = sets.reduce((a: Any, s: Any) => (Number(s.kg) > Number(a.kg) || (Number(s.kg) === Number(a.kg) && Number(s.r) > Number(a.r)) ? s : a));
      break;
    }
    if (!best) continue;
    const hi = Number(ex.hi) || 8, lo = Number(ex.lo) || 5, k = Number(best.kg), r = Number(best.r);
    const step = Number(ex.inc) || inc;
    out.push(`${clean(ex.name)} ${r >= hi ? `${kg(k + step)}kg × ${lo}` : `${kg(k)}kg × ${r + 1}`}`);
    if (out.length >= max) break;
  }
  return out;
}
/* gym days in a row, counting back from yesterday (today counts once it's logged) */
function gymStreak(ctx: Any, today: string) {
  const days = new Set((ctx.logs || []).map((l: Any) => l.date));
  let d = days.has(today) ? today : addDays(today, -1), n = 0;
  while (days.has(d) && n < 1000) { n++; d = addDays(d, -1); }
  return n;
}

async function morningNote(userId: string, ctx: Any, now: Any): Promise<Note> {
  const plan = planFor(ctx, now.dow);
  const lines: string[] = [];
  const st = ctx.streakStart ? Math.max(0, daysBetween(ctx.streakStart, now.date)) : 0;
  lines.push(st > 0 ? `🔥 ${st}-day streak. Don't stop now.` : "🔥 Day 1 of a new streak. Make it count.");
  if (plan) {
    await loadLogs(userId, ctx);
    const t = targetsFor(ctx, plan, now.date, 3);
    const names = (plan.ex || []).map((e: Any) => clean(e.name));
    lines.push(`🏋️ ${plan.name}: ${t.length ? t.join(", ") : names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}.`);
  }
  const q = ctx.quotes.length ? ctx.quotes[(Number(now.date.replace(/-/g, "")) * 7) % ctx.quotes.length] : "Win the morning, win the day.";
  lines.push(`"${String(q).trim()}"`);
  return { id: "m:morning", title: "☀️ Morning briefing", body: lines.join("\n"), go: "briefing" };
}

const PUSH_LINES = ["No easy sets.", "Leave nothing in the tank.", "The last rep is the one that counts.", "Earn the bulk.", "Progressive overload or it didn't happen.", "Every set to failure, clean form.", "Beat last week's you."];

async function gymNote(userId: string, ctx: Any, now: Any): Promise<Note | null> {
  const plan = planFor(ctx, now.dow);
  if (!plan || !Array.isArray(plan.ex) || !plan.ex.length) return null;
  await loadLogs(userId, ctx);
  const t = targetsFor(ctx, plan, now.date, 4);
  const n = gymStreak(ctx, now.date);
  const lines = [n ? `You've hit the gym ${n} day${n === 1 ? "" : "s"} in a row. Don't stop now.` : "Start a new gym streak today."];
  lines.push(t.length ? `Targets: ${t.join(", ")}.` : `${plan.ex.length} lifts. Log every set so next week has numbers to beat.`);
  lines.push(PUSH_LINES[(now.dow + Number(now.date.slice(8))) % PUSH_LINES.length]);
  return { id: "g:gym", title: `🏋️ ${plan.name} day`, body: lines.join("\n"), go: "workout" };
}

function tickNote(ctx: Any, now: Any, which: string): Note | null {
  const open = ctx.items.filter((it: Any) => !it.done && it.refId !== "sleep" && (toMins(it.time) < 0 || toMins(it.time) <= now.mins));
  const list = ctx.list.filter((x: Any) => !x.done);
  const rems = ctx.rems;
  const total = open.length + list.length + rems.length;
  if (!total) return null;
  const bits = [];
  if (open.length) bits.push(`${open.length} routine`);
  if (list.length) bits.push(`${list.length} on Today's List`);
  if (rems.length) bits.push(`${rems.length} reminder${rems.length === 1 ? "" : "s"}`);
  const names = open.slice(0, 3).map((it: Any) => clean(it.title)).join(", ");
  return {
    id: "t:" + which, title: "✅ Tick off LifeOS",
    body: `You've got ${total} thing${total === 1 ? "" : "s"} to tick: ${bits.join(", ")}.${names ? ` Starting with ${names}.` : ""}`,
    go: "tickoff",
  };
}

function eveningNote(ctx: Any): Note | null {
  const open = ctx.items.filter((it: Any) => !it.done && it.refId !== "sleep");
  const list = ctx.list.filter((x: Any) => !x.done);
  const left = open.length + list.length + ctx.rems.length;
  if (!left && ctx.reviewed) return null;
  const parts: string[] = [];
  if (left) parts.push(`${left} thing${left === 1 ? "" : "s"} still to tick${open.length ? `: ${open.slice(0, 3).map((it: Any) => clean(it.title)).join(", ")}${open.length > 3 ? "…" : "."}` : "."}`);
  if (!ctx.reviewed) parts.push("Then write your daily review.");
  return { id: "e:evening", title: "🌙 Tick off + daily review", body: parts.join(" "), go: left ? "tickoff" : "review" };
}
function focusNotes(ctx: Any, now: Any): Note[] {
  const out: Note[] = [];
  for (const f of ctx.focuses) {
    if (!f.end || !f.start || f.start > now.date || f.end < now.date) continue;
    const left = daysBetween(now.date, f.end);
    if (left > 2) continue;
    const when = left === 0 ? "ends today" : left === 1 ? "ends tomorrow" : "ends in 2 days";
    out.push({
      id: `f:${f.kind}:${f.end}:${left}`, title: `🎯 ${f.kind} Focus ${when}`,
      body: `"${clean(f.name)}" ${when}. Set up your next ${f.kind === "Ecom" ? "Ecommerce" : "Life"} Focus so there's no gap.`,
      go: f.kind === "Ecom" ? "ecom" : "life",
    });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const cfg = await config();
    webpush.setVapidDetails(cfg.subject || "mailto:lifeos@example.com", cfg.vapid_public, cfg.vapid_private);
    const body = await req.json().catch(() => ({}));
    const now = nzNow();

    // ---- from the app: test (plain, a real morning briefing, or the gym one) ----
    if (body && body.test) {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u, error } = await sb.auth.getUser(token);
      if (error || !u?.user) return json({ error: "Sign in to sync first" }, 401);
      const subRows = await rows(u.user.id, (q) => q.eq("key", "pushSubs"));
      const subs = subRows[0]?.value?.v || {};
      if (!Object.values(subs).some((x: Any) => x && !x.off)) return json({ error: "No device has notifications on" }, 400);
      let n: Note = { id: "test", title: "LifeOS", body: "Test notification. You're all set ✓", go: "briefing" };
      const k = String(body.test);
      if (k === "custom" && body.note && typeof body.note === "object") {
        // a custom notification exactly as it's set up (sent now, from the app's draft)
        const x = body.note;
        n = { id: "n:x", title: String(x.title || (x.kind === "sos" ? "🚨 SOS" : "LifeOS")), body: String(x.text || "") + (x.kind === "sos" ? " Tap when it's done." : ""),
          go: withApps(x.kind === "sos" && x.id ? "sos:" + x.id : String(x.go || "briefing"), x.apps) };
        return json(await sendTwice(subs, { ...n, id: "n:test" }));
      }
      const cfgRows = await rows(u.user.id, (q) => q.eq("key", "pushCfg"));
      const ucfg: Any = { ...(cfgRows[0]?.value?.v || {}) };
      if (body.over && typeof body.over === "object") ucfg.over = body.over; // unsaved edits from the edit sheet
      const ctx = k === "true" ? null : await loadDay(u.user.id, now.date);
      if (ctx) {
        if (k === "morning") n = await morningNote(u.user.id, ctx, now);
        else if (k === "gym") n = (await gymNote(u.user.id, ctx, now)) || { id: "g:gym", title: "🏋️ Gym day", body: "No split set for today, so this is a sample.", go: "workout" };
        else if (k === "tick") n = tickNote(ctx, now, "x") || { id: "t:x", title: "✅ Tick off LifeOS", body: "Nothing left to tick right now, so this is a sample.", go: "tickoff" };
        else if (k === "evening") n = eveningNote(ctx) || { id: "e:evening", title: "🌙 Tick off + daily review", body: "All done today, so this is a sample.", go: "review" };
        else if (k === "focus") n = focusNotes(ctx, now)[0] || { id: "f:x", title: "🎯 Life Focus ends tomorrow", body: "Sample: set up your next Life Focus so there's no gap.", go: "life" };
        else if (k === "missed") n = { id: "u:x", title: "⏰ Not ticked yet", body: "Sample: a routine task was due 30 min ago. Done it? Tick it off.", go: "tickoff" };
        else if (k === "rem") n = { id: "r:x", title: "🔔 Reminder", body: "Sample reminder", go: "reminders" };
        n = over(n, ucfg);
      }
      return json(await sendTwice(subs, { ...n, id: n.id + ":test" }));
    }

    // ---- scheduled run ----
    if (!cfg.cron_secret || req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ error: "forbidden" }, 403);
    const due = (t: unknown) => { const m = toMins(t); return m >= 0 && m <= now.mins && now.mins - m < WINDOW_MIN; };

    // dry run: show what each notification would say right now, send nothing
    if (body && body.dry && body.user) {
      const ctx = await loadDay(String(body.user), now.date);
      if (body.dow != null) now.dow = Number(body.dow);
      if (body.send) {
        const subRows = await rows(String(body.user), (q) => q.eq("key", "pushSubs"));
        const n = body.send === "gym" ? await gymNote(String(body.user), ctx, now) : await morningNote(String(body.user), ctx, now);
        if (!n) return json({ error: "nothing to send" }, 400);
        return json(await sendTwice(subRows[0]?.value?.v || {}, { ...n, id: n.id + ":test" }));
      }
      return json({
        now, items: ctx.items.length, morning: await morningNote(String(body.user), ctx, now), gym: await gymNote(String(body.user), ctx, now),
        tick: tickNote(ctx, now, "1"), evening: eveningNote(ctx), focus: focusNotes(ctx, now),
      });
    }

    const base = await rows(null, (q) => q.in("key", ["notifs", "pushSubs", "pushCfg"]));
    const users = new Map<string, Any>();
    for (const r of base) {
      const u = users.get(r.user_id) || {};
      const v = r.value?.v;
      if (r.key === "notifs") u.notifs = Array.isArray(v) ? v : [];
      if (r.key === "pushSubs") u.subs = v && typeof v === "object" ? v : {};
      if (r.key === "pushCfg") u.cfg = v && typeof v === "object" ? v : {};
      users.set(r.user_id, u);
    }

    let sent = 0;
    for (const [userId, u] of users) {
      if (!u.subs || !Object.values(u.subs).some((x: Any) => x && !x.off)) continue;
      const c: Any = u.cfg || {};
      const on = (k: string) => c[k] !== false;
      const out: Note[] = [];

      const ctx = await loadDay(userId, now.date);

      for (const n of (u.notifs || []) as Any[]) {
        if (!n || n.on === false || !n.id) continue;
        const days = Array.isArray(n.days) ? n.days : [];
        const today = n.date ? n.date === now.date : days.length ? days.includes(now.dow) : true;
        if (!today) continue;
        if (n.remId && ctx.remDone.has(String(n.remId))) continue; // its reminder is done
        const title = String(n.title || (n.kind === "sos" ? "🚨 SOS" : "LifeOS")), text = String(n.text || "");
        if (n.kind === "sos") {
          if (n.doneOn === now.date) continue;
          const start = toMins(n.time), every = Math.max(5, Number(n.every) || 15), end = start + Math.max(1, Number(n.hours) || 2) * 60;
          if (start < 0 || now.mins < start || now.mins >= end) continue;
          const k = Math.floor((now.mins - start) / every);
          if (now.mins - (start + k * every) >= Math.min(every, WINDOW_MIN)) continue;
          out.push({ id: `sos:${n.id}:${k}`, title, body: (text ? text + " " : "") + "Tap when it's done.", go: withApps("sos:" + n.id, n.apps) });
        } else if (due(n.time)) out.push({ id: "n:" + n.id, title, body: text, go: withApps(String(n.go || (n.remId ? "reminders" : "briefing")), n.apps) });
      }

      if (!ctx.dayOff) {
        if (on("morning") && due(c.morningTime || "05:30")) out.push(await morningNote(userId, ctx, now));
        if (on("gym")) {
          const g = ctx.items.find((it: Any) => it.refId === "gym" || /\bgym\b/i.test(clean(it.title)));
          const gt = g && toMins(g.time) >= 0 ? toMins(g.time) - 5 : -1;
          if (g && !g.done && gt >= 0 && now.mins >= gt && now.mins - gt < WINDOW_MIN) {
            const n = await gymNote(userId, ctx, now); if (n) out.push(n);
          }
        }
        if (on("tick") && due(c.tick1 || "07:45")) { const n = tickNote(ctx, now, "1"); if (n) out.push(n); }
        if (on("tick") && due(c.tick2 || "17:30")) { const n = tickNote(ctx, now, "2"); if (n) out.push(n); }
        if (on("evening") && due(c.eveningTime || "20:00")) { const n = eveningNote(ctx); if (n) out.push(n); }
        if (c.missed) {
          const after = Math.max(5, Number(c.missedAfter) || 30);
          const late: string[] = [];
          for (const it of ctx.items) {
            const t = toMins(it.time);
            if (it.done || t < 0 || it.refId === "sleep") continue;
            const at = t + after;
            if (at > now.mins || now.mins - at >= WINDOW_MIN || at >= 22 * 60) continue;
            const { error } = await sb.from("lifeos_push_sent").insert({ user_id: userId, notif_id: "u:" + it.id, slot: now.date });
            if (!error) late.push(clean(it.title));
          }
          if (late.length) out.push({ id: "u:batch:" + now.mins, title: "⏰ Not ticked yet", body: late.length === 1 ? `${late[0]} was due ${after} min ago. Done it? Tick it off.` : `${late.join(", ")} still need ticking.`, go: "tickoff" });
        }
      }
      if (on("focus") && due(c.focusTime || "16:00")) out.push(...focusNotes(ctx, now));
      if (c.rem) for (const x of ctx.rems) if (x.time && due(x.time)) out.push({ id: "r:" + x.id, title: "🔔 " + clean(x.title), body: clean(x.notes || "Reminder"), go: "reminders" });

      for (let o of out) {
        o = over(o, c);
        const { error } = await sb.from("lifeos_push_sent").insert({ user_id: userId, notif_id: o.id, slot: now.date });
        if (error) continue; // already sent today
        sent += (await sendTwice(u.subs, o)).ok;
      }
    }
    return json({ at: now, sent });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
