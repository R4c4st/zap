import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Tempo — boîte d'entrée du téléphone. MacroDroid y envoie les appels manqués, SMS, WhatsApp, fins d'appel.
// Tempo les relève à l'ouverture puis les efface d'ici (rien n'est gardé plus de 7 jours).
// Accès MacroDroid : lien secret (?k=…) propre au téléphone. Accès appli : identifiant d'appareil.
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://r4c4st.github.io"];
const MAX_PER_DAY = 400;
const KINDS: Record<string, string> = { appel: "appel", missed: "appel", manque: "appel", sms: "sms", texto: "sms", whatsapp: "whatsapp", wa: "whatsapp", fin: "fin_appel", fin_appel: "fin_appel", notif: "notif" };

async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tempo-inbox:" + s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
const okDev = (d: unknown) => typeof d === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(d);
const okTok = (t: unknown) => typeof t === "string" && /^[a-zA-Z0-9_-]{20,80}$/.test(t);
// variable MacroDroid non remplacée ([sms_message]…) ou vide → rien
const clean = (v: unknown, n: number) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return !s || /^\[[a-z_]+\]$/i.test(s) ? "" : s.slice(0, n); };
const day = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 10);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = { "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const p: Record<string, unknown> = Object.fromEntries(url.searchParams);
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      try {
        if (ct.includes("application/json")) Object.assign(p, await req.json());
        else if (ct.includes("form")) Object.assign(p, Object.fromEntries(await req.formData()));
        else { const t = await req.text(); if (t.trim().startsWith("{")) Object.assign(p, JSON.parse(t)); else if (t.trim() && !p.texte) p.texte = t; }
      } catch (_e) { /* corps illisible : on garde les paramètres d'URL */ }
    }

    // ---- côté appli Tempo ----
    if (p.action === "register") {
      if (!okDev(p.device) || !okTok(p.token)) return json({ error: "bad_request" }, 400);
      await db.from("tempo_inbox_keys").delete().eq("device", p.device);
      await db.from("tempo_inbox_keys").insert({ token_hash: await sha(p.token as string), device: p.device });
      return json({ ok: true });
    }
    if (p.action === "off") {
      if (!okDev(p.device)) return json({ error: "bad_request" }, 400);
      await db.from("tempo_inbox_keys").delete().eq("device", p.device);
      await db.from("tempo_inbox").delete().eq("device", p.device);
      return json({ ok: true });
    }
    if (p.action === "pull") {
      if (!okDev(p.device)) return json({ error: "bad_request" }, 400);
      const { data } = await db.from("tempo_inbox").select("id,kind,who,num,body,app,at").eq("device", p.device).order("at", { ascending: true }).limit(60);
      const ids = (data ?? []).map(r => r.id);
      if (ids.length) await db.from("tempo_inbox").delete().in("id", ids);
      await db.from("tempo_inbox").delete().lt("at", new Date(Date.now() - 7 * 86400000).toISOString());
      const { data: k } = await db.from("tempo_inbox_keys").select("last_at").eq("device", p.device).maybeSingle();
      return json({ ok: true, linked: !!k, last_at: k?.last_at ?? null, events: data ?? [] });
    }

    // ---- côté MacroDroid ----
    const tok = p.k ?? p.key ?? p.token;
    if (!okTok(tok)) return new Response("Tempo : lien incomplet (il manque k=…)", { status: 400, headers: cors });
    const { data: K } = await db.from("tempo_inbox_keys").select("token_hash,device,n_day,day").eq("token_hash", await sha(tok as string)).maybeSingle();
    if (!K) return new Response("Tempo : lien inconnu ou coupé — recrée-le dans Tempo > réglages", { status: 403, headers: cors });
    const today = day(), n = K.day === today ? K.n_day : 0;
    if (n >= MAX_PER_DAY) return new Response("Tempo : trop d'événements aujourd'hui", { status: 429, headers: cors });

    const kind = KINDS[String(p.type ?? p.kind ?? "").toLowerCase().trim()] ?? "notif";
    const ev = { device: K.device, kind, who: clean(p.nom ?? p.who ?? p.name, 80), num: clean(p.num ?? p.number ?? p.tel, 40).replace(/[^\d+]/g, ""), body: clean(p.texte ?? p.text ?? p.message ?? p.body, 1500), app: clean(p.app, 40) };
    const test = String(p.test ?? "") === "1";
    if (!test) {
      if (!ev.who && !ev.num && !ev.body) return new Response("Tempo : rien à noter (événement vide)", { status: 200, headers: cors });
      await db.from("tempo_inbox").insert(ev);
    }
    await db.from("tempo_inbox_keys").update({ last_at: new Date().toISOString(), n_day: n + 1, day: today }).eq("token_hash", K.token_hash);
    return new Response(test ? "Tempo : lien OK ✓" : "ok", { status: 200, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error).message ?? e).slice(0, 200) }, 500);
  }
});
