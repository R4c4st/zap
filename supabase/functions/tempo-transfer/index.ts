import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Tempo — transfert unique des données de Chrome vers l'appli Android.
// Le contenu arrive chiffré (AES-GCM) : la clé reste dans le lien tempo:// entre Chrome et l'appli, jamais ici.
// Lu une seule fois puis effacé ; tout ce qui a plus de 30 min est effacé.
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = ["https://r4c4st.github.io", "https://localhost", "http://localhost", "capacitor://localhost"];
const MAX = 6 * 1024 * 1024;

const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "").split(",")[0].trim() || "?";
// limite de débit (anti-abus) : en cas de souci de base, on laisse passer plutôt que de bloquer l'appli
async function allow(k: string, max: number, win: number) {
  try { const { data, error } = await db.rpc("tempo_hit", { p_k: k, p_max: max, p_win: win }); return error ? true : data !== false; } catch (_e) { return true; }
}
const tooBig = (req: Request, max: number) => +(req.headers.get("content-length") ?? 0) > max;
const rid = () => { const b = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = { "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (tooBig(req, 8 * 1024 * 1024)) return json({ error: "too_big" }, 413);
  const ip = ipOf(req);
  try {
    await db.from("tempo_transfer").delete().lt("created_at", new Date(Date.now() - 30 * 60000).toISOString());
    const b = await req.json();
    if (b.action === "put") {
      if (!(await allow("tr:put:" + ip, 10, 3600))) return json({ error: "rate" }, 429);
      if (typeof b.blob !== "string" || typeof b.iv !== "string" || b.blob.length > MAX || b.iv.length > 64) return json({ error: "bad_request" }, 400);
      const id = rid();
      const { error } = await db.from("tempo_transfer").insert({ id, blob: b.blob, iv: b.iv });
      if (error) return json({ error: "db", detail: error.message }, 500);
      return json({ ok: true, id });
    }
    if (b.action === "get") {
      if (!(await allow("tr:get:" + ip, 60, 3600))) return json({ error: "rate" }, 429);
      if (typeof b.id !== "string" || !/^[A-Za-z0-9_-]{16,40}$/.test(b.id)) return json({ error: "bad_request" }, 400);
      const { data } = await db.from("tempo_transfer").select("blob,iv").eq("id", b.id).maybeSingle();
      if (!data) return json({ error: "not_found" }, 404);
      await db.from("tempo_transfer").delete().eq("id", b.id);
      return json({ ok: true, blob: data.blob, iv: data.iv });
    }
    return json({ error: "bad_action" }, 400);
  } catch (e) {
    return json({ error: "server", detail: String((e as Error).message ?? e).slice(0, 200) }, 500);
  }
});
