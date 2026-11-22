import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Tempo — transcription Voxtral (Mistral) avec compteur et plafond mensuel.
// La clé Mistral reste dans le téléphone : elle transite ici pour l'appel, n'est jamais stockée
// (seule son empreinte SHA-256 sert à compter la dépense et à retenir le plafond).
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://r4c4st.github.io", "https://localhost", "http://localhost", "capacitor://localhost"];
const MODEL = "voxtral-mini-transcribe-3";
const USD_PER_MIN = 0.0035;          // tarif Mistral de ce modèle
const CAP_MIN = 0.5, CAP_MAX = 20;   // le plafond réglable reste entre 0,50 et 20 $
const DEFAULT_CAP = 2;
const MAX_BYTES = 8 * 1024 * 1024;   // ~4 min en WAV 16 kHz, bien plus en webm
const MAX_SEC = 300;

const month = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 7);
async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tempo-voice:" + s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function capOf(kh: string) {
  const { data } = await db.from("tempo_voice_keys").select("cap_usd").eq("key_hash", kh).maybeSingle();
  if (data) return +data.cap_usd;
  await db.from("tempo_voice_keys").upsert({ key_hash: kh, cap_usd: DEFAULT_CAP });
  return DEFAULT_CAP;
}
async function spent(kh: string) {
  const { data } = await db.from("tempo_voice_usage").select("seconds,cost_usd").eq("key_hash", kh).eq("month", month());
  let usd = 0, sec = 0, n = 0;
  for (const r of data ?? []) { usd += +r.cost_usd; sec += +r.seconds; n++; }
  return { usd, sec, n };
}
const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "").split(",")[0].trim() || "?";
// limite de débit (anti-abus) : en cas de souci de base, on laisse passer plutôt que de bloquer l'appli
async function allow(k: string, max: number, win: number) {
  try { const { data, error } = await db.rpc("tempo_hit", { p_k: k, p_max: max, p_win: win }); return error ? true : data !== false; } catch (_e) { return true; }
}
const tooBig = (req: Request, max: number) => +(req.headers.get("content-length") ?? 0) > max;
const okKey = (k: unknown) => typeof k === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(k);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = { "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (tooBig(req, 9 * 1024 * 1024)) return json({ error: "too_big" }, 413);
  const ip = ipOf(req);
  try {
    const ct = req.headers.get("content-type") ?? "";

    // ---- actions simples : usage, plafond ----
    if (ct.includes("application/json")) {
      if (!(await allow("vx:j:" + ip, 300, 3600))) return json({ error: "rate" }, 429);
      const b = await req.json();
      if (!okKey(b.key)) return json({ error: "key" }, 400);
      const kh = await sha(b.key);
      if (b.action === "setcap") {
        const cap = Math.min(CAP_MAX, Math.max(CAP_MIN, +b.cap || DEFAULT_CAP));
        await db.from("tempo_voice_keys").upsert({ key_hash: kh, cap_usd: cap });
      }
      const cap = await capOf(kh), s = await spent(kh);
      return json({ ok: true, month: month(), month_usd: s.usd, month_sec: s.sec, n: s.n, cap_usd: cap, usd_per_min: USD_PER_MIN });
    }

    // ---- transcription ----
    const form = await req.formData();
    const key = form.get("key"), file = form.get("file"), device = String(form.get("device") ?? "").slice(0, 64);
    if (!okKey(key)) return json({ error: "key" }, 400);
    if (!(file instanceof File) || !file.size) return json({ error: "no_audio" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "too_big" }, 413);
    const dur = Math.min(MAX_SEC, Math.max(0, +(form.get("dur") ?? 0) || 0));
    const bias = form.getAll("bias").map(String).map(s => s.trim()).filter(s => s && s.length < 120).slice(0, 80);

    const kh = await sha(key as string);
    if (!(await allow("vx:t:" + ip, 150, 3600)) || !(await allow("vx:k:" + kh, 200, 3600))) return json({ error: "rate" }, 429);
    const cap = await capOf(kh), s = await spent(kh);
    const est = ((dur || 60) / 60) * USD_PER_MIN;
    if (s.usd + est > cap) return json({ capped: true, month_usd: s.usd, month_sec: s.sec, cap_usd: cap }, 200);

    const call = async (withBias: boolean) => {
      const fd = new FormData();
      fd.append("model", MODEL);
      fd.append("file", file, file.name || "dictee.webm");
      fd.append("language", "fr");
      if (withBias) for (const b of bias) fd.append("context_bias", b);
      return await fetch("https://api.mistral.ai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
    };
    const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
    let r = await call(bias.length > 0);
    let detail = "";
    if (r.status === 429) {   // souvent passager (débit, capacité) : on retente une fois
      const d1 = (await r.text()).slice(0, 300);
      console.log("tempo-voice: mistral 429 (1) " + d1);
      await wait(1800);
      r = await call(false);
      if (r.status === 429) {
        const d2 = (await r.text()).slice(0, 300);
        console.log("tempo-voice: mistral 429 (2) " + d2);
        return json({ error: "mistral_limit", detail: d2 || d1 }, 429);
      }
    }
    if (r.status === 400 || r.status === 422) {
      detail = (await r.text()).slice(0, 300);
      const looksFormat = /format|decod|codec|unsupported|invalid (audio|file)|could not (read|process)/i.test(detail);
      if (bias.length && !looksFormat) { r = await call(false); detail = ""; }
      else return json({ error: "format", detail }, 415);
      if (r.status === 400 || r.status === 422) return json({ error: "format", detail: (await r.text()).slice(0, 300) }, 415);
    }
    if (r.status === 401 || r.status === 403) { const d = (await r.text()).slice(0, 300); console.log("tempo-voice: mistral " + r.status + " " + d); return json({ error: "key", detail: d }, 401); }
    if (r.status === 429) return json({ error: "mistral_limit", detail: (await r.text()).slice(0, 300) }, 429);
    if (!r.ok) { const d = (await r.text()).slice(0, 300); console.log("tempo-voice: mistral " + r.status + " " + d); return json({ error: "mistral", status: r.status, detail: d }, 502); }

    const j = await r.json();
    const sec = Math.max(0, +(j?.usage?.prompt_audio_seconds ?? 0) || dur || 0);
    const cost = (sec / 60) * USD_PER_MIN;
    await db.from("tempo_voice_usage").insert({ key_hash: kh, device, month: month(), seconds: sec, cost_usd: cost });
    return json({ ok: true, text: String(j?.text ?? "").trim(), sec, cost_usd: cost, month_usd: s.usd + cost, month_sec: s.sec + sec, cap_usd: cap });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error).message ?? e).slice(0, 200) }, 500);
  }
});
