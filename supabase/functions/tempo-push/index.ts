import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Tempo — rappels qui sonnent : abonnements, programmation, envoi (appelé chaque minute par pg_cron).
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://r4c4st.github.io"];
let CONF: Record<string, string> | null = null;
async function conf() {
  if (CONF) return CONF;
  const { data } = await db.from("tempo_config").select("k,v");
  CONF = Object.fromEntries((data ?? []).map((r: { k: string; v: string }) => [r.k, r.v]));
  webpush.setVapidDetails("https://r4c4st.github.io/zap/", CONF.vapid_public, CONF.vapid_private);
  return CONF;
}
async function logErr(what: string) {
  console.log("tempo-push:", what);
  await db.from("tempo_config").upsert({ k: "last_error", v: new Date().toISOString() + " " + what.slice(0, 900) });
}
const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "").split(",")[0].trim() || "?";
// limite de débit (anti-abus) : en cas de souci de base, on laisse passer plutôt que de bloquer l'appli
async function allow(k: string, max: number, win: number) {
  try { const { data, error } = await db.rpc("tempo_hit", { p_k: k, p_max: max, p_win: win }); return error ? true : data !== false; } catch (_e) { return true; }
}
const tooBig = (req: Request, max: number) => +(req.headers.get("content-length") ?? 0) > max;
async function hasSub(device: string) {
  const { count } = await db.from("tempo_push_subs").select("device", { count: "exact", head: true }).eq("device", device);
  return (count ?? 0) > 0;
}
async function send(device: string, payload: unknown, keepOnFail = false) {
  const { data, error } = await db.from("tempo_push_subs").select("sub").eq("device", device).maybeSingle();
  if (error) { await logErr("select " + error.message); return { ok: false, why: "db" }; }
  if (!data) return { ok: false, why: "no_sub" };
  try {
    await webpush.sendNotification(data.sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
    return { ok: true };
  } catch (e) {
    const err = e as { statusCode?: number; body?: string; message?: string };
    await logErr(`push ${err.statusCode ?? "?"} ${err.body ?? ""} ${err.message ?? e}`);
    // abonnement mort : on le retire ; l'appli se réabonne seule à sa prochaine ouverture (v39)
    if (!keepOnFail && (err.statusCode === 404 || err.statusCode === 410)) await db.from("tempo_push_subs").delete().eq("device", device);
    return { ok: false, why: "push_" + (err.statusCode ?? "err"), detail: String(err.body || err.message || e).slice(0, 200) };
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = { "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (tooBig(req, 512 * 1024)) return json({ error: "too_big" }, 413);
  try {
    const c = await conf();
    const b = await req.json();
    const dev = typeof b.device === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(b.device) ? b.device : null;
    if (b.action !== "dispatch") {
      if (!(await allow("ps:ip:" + ipOf(req), 600, 3600)) || (dev && !(await allow("ps:d:" + dev, 400, 3600)))) return json({ error: "rate" }, 429);
    }
    if (b.action === "key") return json({ key: c.vapid_public });
    if (b.action === "subscribe") {
      if (!dev || !b.sub || !b.sub.endpoint) { await logErr("subscribe bad_request " + JSON.stringify({ dev: !!dev, hasSub: !!b.sub })); return json({ error: "bad_request" }, 400); }
      const { error } = await db.from("tempo_push_subs").upsert({ device: dev, sub: b.sub, updated_at: new Date().toISOString() });
      if (error) { await logErr("subscribe " + error.message); return json({ ok: false, error: error.message }, 500); }
      return json({ ok: true });
    }
    if (b.action === "status") {
      if (!dev) return json({ error: "bad_request" }, 400);
      return json({ ok: true, sub: await hasSub(dev) });
    }
    if (b.action === "sync") {
      if (!dev || !Array.isArray(b.reminders)) return json({ error: "bad_request" }, 400);
      await db.from("tempo_reminders").delete().eq("device", dev).eq("sent", false);
      const now = Date.now();
      const rows = b.reminders.slice(0, 300).filter((r: { at: string }) => { const t = Date.parse(r.at); return t > now - 60000 && t < now + 40 * 86400000; })
        .map((r: { at: string; title: string; body?: string; url?: string; tag?: string }) => ({ device: dev, fire_at: new Date(r.at).toISOString(), title: String(r.title).slice(0, 140), body: r.body ? String(r.body).slice(0, 300) : null, url: r.url ? String(r.url).slice(0, 300) : null, tag: r.tag ? String(r.tag).slice(0, 80) : null }));
      if (rows.length) { const { error } = await db.from("tempo_reminders").insert(rows); if (error) await logErr("sync " + error.message); }
      return json({ ok: true, n: rows.length, sub: await hasSub(dev) });
    }
    if (b.action === "test") {
      if (!dev) return json({ error: "bad_request" }, 400);
      return json(await send(dev, { title: "Tempo", body: "Les rappels fonctionnent. Je sonnerai au bon moment.", url: "./", tag: "test" }, true));
    }
    if (b.action === "dispatch") {
      if (b.secret !== c.cron_secret) return json({ error: "forbidden" }, 403);
      const nowIso = new Date().toISOString(), old = new Date(Date.now() - 30 * 60000).toISOString();
      const { data: due } = await db.from("tempo_reminders").select("*").eq("sent", false).lte("fire_at", nowIso).limit(100);
      let sent = 0;
      for (const r of due ?? []) {
        await db.from("tempo_reminders").update({ sent: true }).eq("id", r.id);
        if (r.fire_at < old) continue;
        const res = await send(r.device, { title: r.title, body: r.body, url: r.url, tag: r.tag });
        if (res.ok) sent++;
      }
      await db.from("tempo_reminders").delete().eq("sent", true).lt("fire_at", new Date(Date.now() - 3 * 86400000).toISOString());
      return json({ ok: true, due: (due ?? []).length, sent });
    }
    return json({ error: "bad_action" }, 400);
  } catch (e) {
    await logErr("server " + String((e as Error).message ?? e));
    return json({ error: "server", detail: String((e as Error).message ?? e).slice(0, 200) }, 500);
  }
});
