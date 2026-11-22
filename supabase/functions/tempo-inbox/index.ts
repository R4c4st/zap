import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Tempo — boîte d'entrée du téléphone. MacroDroid y envoie les notifications Téléphone / Messages / WhatsApp
// (ou, en mode avancé, des appels manqués, SMS, fins d'appel déjà typés).
// Tempo les relève à l'ouverture puis les efface d'ici (rien n'est gardé plus de 7 jours).
// Accès MacroDroid : lien secret (?k=…) propre au téléphone. Accès appli : identifiant d'appareil.
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://r4c4st.github.io", "https://localhost", "http://localhost", "capacitor://localhost"];
const MAX_PER_DAY = 400;
const KINDS: Record<string, string> = { appel: "appel", missed: "appel", manque: "appel", sms: "sms", texto: "sms", whatsapp: "whatsapp", wa: "whatsapp", fin: "fin_appel", fin_appel: "fin_appel", notif: "notif" };
const MISSED = /appels? (?:vocal |vid[ée]o )?manqu|missed (?:voice |video )?call|appels? en absence|appels? non r[ée]pondu/i;
const PHONE_RX = /(?:\+\d{2}\s?|0)\d(?:[\s.-]?\d{2}){4}|\+\d{8,15}/;

const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "").split(",")[0].trim() || "?";
// limite de débit (anti-abus) : en cas de souci de base, on laisse passer plutôt que de bloquer l'appli
async function allow(k: string, max: number, win: number) {
  try { const { data, error } = await db.rpc("tempo_hit", { p_k: k, p_max: max, p_win: win }); return error ? true : data !== false; } catch (_e) { return true; }
}
const tooBig = (req: Request, max: number) => +(req.headers.get("content-length") ?? 0) > max;
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tempo-inbox:" + s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
const okDev = (d: unknown) => typeof d === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(d);
const okTok = (t: unknown) => typeof t === "string" && /^[a-zA-Z0-9_-]{20,80}$/.test(t);
// variable MacroDroid non remplacée ([sms_message], {not_title}…) ou vide → rien
const clean = (v: unknown, n: number) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return !s || /^[\[{][a-z_=.]+[\]}]$/i.test(s) ? "" : s.slice(0, n); };
const isNum = (s: string) => /^[+\d][\d\s.()-]{5,}$/.test(s);
const day = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 10);

type Ev = { kind: string; who: string; num: string; body: string; app: string };
// Une notification (appli, titre, texte) → un événement Tempo, ou null si rien d'utile
export function fromNotification(app: string, title: string, text: string): Ev | null {
  const a = app.toLowerCase();
  if (/whatsapp/.test(a)) {
    if (!title || /^whatsapp( business)?$/i.test(title) || /^\d+ (nouveaux? )?messages?\b/i.test(text) && /discussions?|chats?/i.test(text)) return null;   // résumé « 5 messages de 2 discussions »
    if (/^(appel|call)|appel (vocal|vidéo) (manqué|entrant)/i.test(text) && !MISSED.test(text)) return null;
    return MISSED.test(text) ? { kind: "appel", who: title.replace(/\s*\(\d+ messages?\)$/i, ""), num: "", body: "appel WhatsApp manqué", app: "WhatsApp" }
      : { kind: "whatsapp", who: title.replace(/\s*\(\d+ messages?\)$/i, ""), num: "", body: text, app: "WhatsApp" };
  }
  if (/t[ée]l[ée]phone|phone|dialer|appel|contacts?$/.test(a)) {
    const tm = MISSED.test(title), xm = MISSED.test(text);
    if (!tm && !xm) return null;                                     // appel en cours, messagerie vocale… : rien
    let who = (tm ? text : title).replace(MISSED, "").replace(/^[\s:·,-]+|[\s:·,-]+$/g, "").trim();
    if (/masqu|inconnu|priv[ée]|unknown|private/i.test(who)) who = "";
    let num = "";
    const m = (title + " " + text).match(PHONE_RX);
    if (isNum(who)) { num = who.replace(/[^\d+]/g, ""); who = ""; } else if (m) num = m[0].replace(/[^\d+]/g, "");
    if (!who && !num) return null;                                   // numéro masqué
    return { kind: "appel", who, num, body: "", app: "Téléphone" };
  }
  if (/messag|sms|mms/.test(a)) {
    if (!title || /^\d+ (nouveaux? )?messages?$/i.test(title)) return null;
    const num = isNum(title) ? title.replace(/[^\d+]/g, "") : "";
    return { kind: "sms", who: num ? "" : title, num, body: text, app: "Messages" };
  }
  if (!title && !text) return null;
  return { kind: "notif", who: title, num: "", body: text, app };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = { "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  const txt = (s: string, status = 200) => new Response(s, { status, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (tooBig(req, 64 * 1024)) return json({ error: "too_big" }, 413);
  const ip = ipOf(req);
  try {
    const url = new URL(req.url);
    const p: Record<string, unknown> = Object.fromEntries(url.searchParams);
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      try {
        if (ct.includes("application/json")) Object.assign(p, await req.json());
        else if (ct.includes("form")) Object.assign(p, Object.fromEntries(await req.formData()));
        else {
          const t = await req.text();
          if (t.trim().startsWith("{")) Object.assign(p, JSON.parse(t));
          else if (t.trim()) {
            // corps texte de MacroDroid : 1re ligne = appli, 2e = titre, le reste = texte de la notification
            const lines = t.replace(/\r/g, "").split("\n");
            if (lines.length >= 2 && !p.type) { p.app = lines[0]; p.titre = lines[1]; p.texte = lines.slice(2).join(" "); }
            else if (!p.texte) p.texte = t;
          }
        }
      } catch (_e) { /* corps illisible : on garde les paramètres d'URL */ }
    }

    // ---- côté appli Tempo ----
    if (p.action === "register") {
      if (!(await allow("ib:r:" + ip, 20, 3600))) return json({ error: "rate" }, 429);
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
      if (!(await allow("ib:p:" + ip, 600, 3600))) return json({ error: "rate" }, 429);
      if (!okDev(p.device)) return json({ error: "bad_request" }, 400);
      const { data } = await db.from("tempo_inbox").select("id,kind,who,num,body,app,at").eq("device", p.device).order("at", { ascending: true }).limit(60);
      const ids = (data ?? []).map(r => r.id);
      if (ids.length) await db.from("tempo_inbox").delete().in("id", ids);
      await db.from("tempo_inbox").delete().lt("at", new Date(Date.now() - 7 * 86400000).toISOString());
      const { data: k } = await db.from("tempo_inbox_keys").select("last_at").eq("device", p.device).maybeSingle();
      return json({ ok: true, linked: !!k, last_at: k?.last_at ?? null, events: data ?? [] });
    }

    // ---- côté MacroDroid ----
    if (!(await allow("ib:m:" + ip, 600, 3600))) return txt("Tempo : trop d'envois, réessaie plus tard", 429);
    const tok = p.k ?? p.key ?? p.token;
    if (!okTok(tok)) return txt("Tempo : lien incomplet (il manque k=…)", 400);
    const { data: K } = await db.from("tempo_inbox_keys").select("token_hash,device,n_day,day,recent").eq("token_hash", await sha(tok as string)).maybeSingle();
    if (!K) return txt("Tempo : lien inconnu ou coupé — recrée-le dans Tempo > réglages", 403);
    const today = day(), n = K.day === today ? K.n_day : 0;
    if (n >= MAX_PER_DAY) return txt("Tempo : trop d'événements aujourd'hui", 429);
    const test = String(p.test ?? "") === "1";

    let ev: Ev | null;
    const app = clean(p.app, 40), titre = clean(p.titre ?? p.title, 120), texte = clean(p.texte ?? p.text ?? p.message ?? p.body, 1500);
    if (!p.type && !p.kind && app) ev = fromNotification(app, titre, texte);
    else {
      const kind = KINDS[String(p.type ?? p.kind ?? "").toLowerCase().trim()] ?? "notif";
      let who = clean(p.nom ?? p.who ?? p.name ?? titre, 80), num = clean(p.num ?? p.number ?? p.tel, 40).replace(/[^\d+]/g, "");
      if (who && isNum(who)) { if (!num) num = who.replace(/[^\d+]/g, ""); who = ""; }
      ev = (who || num || texte) ? { kind, who, num, body: texte, app } : null;
    }
    const touch = async (recent: unknown) => { await db.from("tempo_inbox_keys").update({ last_at: new Date().toISOString(), n_day: n + 1, day: today, recent }).eq("token_hash", K.token_hash); };
    if (test) { await touch(K.recent ?? []); return txt("Tempo : lien OK ✓"); }
    if (!ev) { await touch(K.recent ?? []); return txt("Tempo : rien à noter"); }

    // la même notification qui se met à jour plusieurs fois (WhatsApp…) : on ne la garde qu'une fois
    const sig = await sha([ev.kind, ev.who, ev.num, ev.body].join("|")), now = Date.now();
    const recent = ((K.recent ?? []) as { s: string; t: number }[]).filter(r => now - r.t < 10 * 60000);
    if (recent.some(r => r.s === sig)) { await touch(recent); return txt("Tempo : déjà reçu"); }
    recent.push({ s: sig, t: now });
    await db.from("tempo_inbox").insert({ device: K.device, kind: ev.kind, who: ev.who.slice(0, 80), num: ev.num.slice(0, 40), body: ev.body, app: ev.app.slice(0, 40) });
    await touch(recent.slice(-30));
    return txt("ok");
  } catch (e) {
    return json({ error: "server", detail: String((e as Error).message ?? e).slice(0, 200) }, 500);
  }
});
