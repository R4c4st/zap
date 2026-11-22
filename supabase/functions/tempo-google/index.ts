import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Tempo — échange et rafraîchissement des jetons Google (le secret Google reste ici, jamais dans l'appli).
const CID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const SEC = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const ORIGINS = ["https://r4c4st.github.io", "https://localhost", "http://localhost", "capacitor://localhost"];
const REDIRECT_PREFIX = "https://r4c4st.github.io/zap/";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const b = await req.json();
    if (b.action === "config") return json({ client_id: CID, ready: !!(CID && SEC) });
    if (!CID || !SEC) return json({ error: "not_configured" }, 500);
    const p = new URLSearchParams({ client_id: CID, client_secret: SEC });
    if (b.action === "exchange") {
      if (typeof b.code !== "string" || typeof b.redirect_uri !== "string" || !b.redirect_uri.startsWith(REDIRECT_PREFIX)) return json({ error: "bad_request" }, 400);
      p.set("grant_type", "authorization_code"); p.set("code", b.code); p.set("redirect_uri", b.redirect_uri);
    } else if (b.action === "refresh") {
      if (typeof b.refresh_token !== "string") return json({ error: "bad_request" }, 400);
      p.set("grant_type", "refresh_token"); p.set("refresh_token", b.refresh_token);
    } else return json({ error: "bad_action" }, 400);
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: p });
    const j = await r.json();
    return json(j, r.status);
  } catch (_e) {
    return json({ error: "server" }, 500);
  }
});
