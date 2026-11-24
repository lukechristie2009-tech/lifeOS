// LifeOS push notifications.
// Called every 5 minutes by pg_cron (header x-cron-secret), and by the app
// (Authorization: Bearer <user access token>) with {test:true|'morning'|'gym'}.
//
// Built-in notifications (each switchable in pushCfg, times in NZ time):
//   morning   05:30  briefing nudge + today's workout + a short quote       -> opens Dashboard
//   gym       5 min before the Gym task: today's split + targets to beat    -> opens Workout
//   tick-off  at the app's two tick-off times (17:30, 20:00) if things open -> opens the tick-off
//   streak    19:30  perfect-day streak at risk                              -> opens the tick-off
//   review    20:45  daily review not written yet                            -> opens today's review
//   focus     16:00  Life / Ecom focus ends in 2 days, tomorrow, or today    -> opens Focus
//   rem       reminders that have a time ping at that time (off by default)
// Plus the user's own scheduled notifications (state.notifs).
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
    if (!sub || typeof sub !== "object" || !(sub as Any).endpoint) continue;
    try {
      // deno-lint-ignore no-explicit-any
      await webpush.sendNotification(sub as any, payload, { TTL: 3600, urgency: "high" });
      ok++;
    } catch (e) {
      fail++; console.error("push failed", (e as Any).statusCode, String(e).slice(0, 200));
    }
  }
  return { ok, fail };
}

/* Everything about a user's day, loaded once per run */
async function loadDay(userId: string, date: string) {
  const r = await rows(userId, (q) => q.or(
    `key.like.lifeFocuses#%,key.like.ecommerceFocuses#%,key.eq.todaysLists#${date},key.eq.briefings,key.eq.daysOff,` +
    `key.like.reminders#%,key.eq.workout,key.eq.quotes,key.eq.dailyReviews#${date},key.eq.checkInTimes`,
  ));
  const ctx: Any = { focuses: [], items: [], list: [], rems: [], brief: "", dayOff: false, workout: null, quotes: [], reviewed: false, ci: {}, byDate: {} };
  for (const row of r) {
    const v = row.value?.v, k = row.key as string;
    if (v == null) continue;
    if (k.startsWith("todaysLists#")) ctx.list = Array.isArray(v.items) ? v.items : [];
    else if (k === "briefings") ctx.brief = String(v[date] || "").trim();
    else if (k === "daysOff") ctx.dayOff = (Array.isArray(v) ? v : []).some((d: Any) => d && d.startDate && d.startDate <= date && (d.endDate || d.startDate) >= date);
    else if (k.startsWith("reminders#")) { if (v.id && !v.done && !v.dismissed && v.date === date) ctx.rems.push(v); }
    else if (k === "workout") ctx.workout = v;
    else if (k === "quotes") ctx.quotes = Array.isArray(v) ? v : [];
    else if (k.startsWith("dailyReviews#")) ctx.reviewed = !!v;
    else if (k === "checkInTimes") ctx.ci = v || {};
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

function morningNote(ctx: Any, now: Any): Note {
  const plan = planFor(ctx, now.dow);
  const parts: string[] = [];
  parts.push(ctx.brief ? "Your briefing's ready, tap to read it." : "Tap to see today's plan.");
  if (plan) parts.push(`Workout: ${plan.name} day.`);
  const left = ctx.items.filter((it: Any) => !it.done).length;
  if (left) parts.push(`${left} tasks today${ctx.rems.length ? `, ${ctx.rems.length} reminder${ctx.rems.length === 1 ? "" : "s"}` : ""}.`);
  const q = ctx.quotes.length ? ctx.quotes[(Number(now.date.replace(/-/g, "")) * 7) % ctx.quotes.length] : "Win the morning, win the day.";
  parts.push(`"${String(q).trim()}"`);
  return { id: "m:morning", title: "☀️ Morning briefing", body: parts.join(" "), go: "briefing" };
}

const PUSH_LINES = ["No easy sets.", "Leave nothing in the tank.", "The last rep is the one that counts.", "Earn the bulk.", "Progressive overload or it didn't happen.", "Every set to failure, clean form.", "Beat last week's you."];

async function gymNote(userId: string, ctx: Any, now: Any): Promise<Note | null> {
  const plan = planFor(ctx, now.dow);
  if (!plan || !Array.isArray(plan.ex) || !plan.ex.length) return null;
  const logs = (await rows(userId, (q) => q.like("key", "workoutLog#%").neq("key", "workoutLog#~order")))
    .map((r) => r.value?.v).filter((l) => l && l.date && l.date < now.date && Array.isArray(l.ex))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const inc = Number(ctx.workout?.cfg?.inc) || 1.25;
  const targets: string[] = [];
  for (const ex of plan.ex) {
    let best: Any = null;
    for (const l of logs) {
      const e = l.ex.find((x: Any) => x.exId === ex.id || clean(x.name) === clean(ex.name));
      const sets = e && Array.isArray(e.sets) ? e.sets.filter((s: Any) => s.done && Number(s.kg) >= 0 && Number(s.r) > 0) : [];
      if (!sets.length) continue;
      best = sets.reduce((a: Any, s: Any) => (Number(s.kg) > Number(a.kg) || (Number(s.kg) === Number(a.kg) && Number(s.r) > Number(a.r)) ? s : a));
      break;
    }
    if (!best) continue;
    const hi = Number(ex.hi) || 8, lo = Number(ex.lo) || 5, k = Number(best.kg), r = Number(best.r);
    const step = Number(ex.inc) || inc;
    targets.push(`${clean(ex.name)} ${r >= hi ? `${kg(k + step)}kg × ${lo}` : `${kg(k)}kg × ${r + 1}`}`);
    if (targets.length >= 4) break;
  }
  const lines = [`${plan.ex.length} lifts.`];
  lines.push(targets.length ? `Targets: ${targets.join(", ")}.` : "Log every set so next week has numbers to beat.");
  lines.push(PUSH_LINES[(now.dow + Number(now.date.slice(8))) % PUSH_LINES.length]);
  return { id: "g:gym", title: `🏋️ ${plan.name} day: add a rep to everything`, body: lines.join(" "), go: "workout" };
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

function perfectStreak(ctx: Any, today: string) {
  let n = 0, d = addDays(today, -1);
  for (let i = 0; i < 400; i++) {
    const its = ctx.byDate[d];
    if (!its || !its.length || !its.every((it: Any) => it.done)) break;
    n++; d = addDays(d, -1);
  }
  return n;
}
function streakNote(ctx: Any, now: Any): Note | null {
  const left = ctx.items.filter((it: Any) => !it.done);
  if (!ctx.items.length || !left.length) return null;
  const n = perfectStreak(ctx, now.date);
  const names = left.slice(0, 3).map((it: Any) => clean(it.title)).join(", ");
  return {
    id: "s:streak",
    title: n ? `🔥 ${n}-day streak at risk` : "🔥 Perfect day still possible",
    body: `${left.length} task${left.length === 1 ? "" : "s"} left today${names ? `: ${names}` : ""}${left.length > 3 ? "…" : "."} ${n ? "Tick them to keep it alive." : "Finish them to start a streak."}`,
    go: "tickoff",
  };
}
function reviewNote(ctx: Any): Note | null {
  if (ctx.reviewed) return null;
  const done = ctx.items.filter((it: Any) => it.done).length;
  return { id: "v:review", title: "📝 Rate your day", body: `${done} of ${ctx.items.length} tasks done today. Take 2 minutes to write your daily review.`, go: "review" };
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
      if (!Object.keys(subs).length) return json({ error: "No device is set up for notifications yet" }, 400);
      let n: Note = { id: "test", title: "LifeOS", body: "Test notification. You're all set ✓", go: "briefing" };
      if (body.test === "morning") n = morningNote(await loadDay(u.user.id, now.date), now);
      if (body.test === "gym") n = (await gymNote(u.user.id, await loadDay(u.user.id, now.date), now)) || n;
      return json(await sendAll(subs, { ...n, id: n.id + ":test" }));
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
        const n = body.send === "gym" ? await gymNote(String(body.user), ctx, now) : morningNote(ctx, now);
        if (!n) return json({ error: "nothing to send" }, 400);
        return json(await sendAll(subRows[0]?.value?.v || {}, { ...n, id: n.id + ":test" }));
      }
      return json({
        now, items: ctx.items.length, morning: morningNote(ctx, now), gym: await gymNote(String(body.user), ctx, now),
        tick: tickNote(ctx, now, "a"), streak: streakNote(ctx, now), review: reviewNote(ctx), focus: focusNotes(ctx, now),
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
      if (!u.subs || !Object.keys(u.subs).length) continue;
      const c: Any = u.cfg || {};
      const on = (k: string) => c[k] !== false;
      const out: Note[] = [];

      for (const n of (u.notifs || []) as Any[]) {
        if (!n || n.on === false || !n.id || !due(n.time)) continue;
        const days = Array.isArray(n.days) ? n.days : [];
        const today = n.date ? n.date === now.date : days.length ? days.includes(now.dow) : true;
        if (today) out.push({ id: "n:" + n.id, title: String(n.title || "LifeOS"), body: String(n.text || ""), go: n.go || "briefing" });
      }

      const ctx = await loadDay(userId, now.date);
      if (!ctx.dayOff) {
        if (on("morning") && due(c.morningTime || "05:30")) out.push(morningNote(ctx, now));
        if (on("gym")) {
          const g = ctx.items.find((it: Any) => it.refId === "gym" || /\bgym\b/i.test(clean(it.title)));
          const gt = g && toMins(g.time) >= 0 ? toMins(g.time) - 5 : -1;
          if (g && !g.done && gt >= 0 && now.mins >= gt && now.mins - gt < WINDOW_MIN) {
            const n = await gymNote(userId, ctx, now); if (n) out.push(n);
          }
        }
        const a = ctx.ci.a || "17:30", b = ctx.ci.b || "20:00";
        if (on("tick") && due(a)) { const n = tickNote(ctx, now, "a"); if (n) out.push(n); }
        if (on("tick") && due(b)) { const n = tickNote(ctx, now, "b"); if (n) out.push(n); }
        if (on("streak") && due(c.streakTime || "19:30")) { const n = streakNote(ctx, now); if (n) out.push(n); }
        if (on("review") && due(c.reviewTime || "20:45")) { const n = reviewNote(ctx); if (n) out.push(n); }
      }
      if (on("focus") && due(c.focusTime || "16:00")) out.push(...focusNotes(ctx, now));
      if (c.rem) for (const x of ctx.rems) if (x.time && due(x.time)) out.push({ id: "r:" + x.id, title: "🔔 Reminder", body: clean(x.title), go: "reminders" });

      for (const o of out) {
        const { error } = await sb.from("lifeos_push_sent").insert({ user_id: userId, notif_id: o.id, slot: now.date });
        if (error) continue; // already sent today
        sent += (await sendAll(u.subs, o)).ok;
      }
    }
    return json({ at: now, sent });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
