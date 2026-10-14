// Carcass Trace: Zid connection (Supabase Edge Function "zid")
//
// Deploy with "Verify JWT" turned OFF: Zid's OAuth redirect reaches this function without a
// Supabase login. Every other action checks the staff member's login itself.
//
// Secrets to set in Supabase (Edge Functions > Secrets):
//   ZID_CLIENT_ID, ZID_CLIENT_SECRET   from your app in the Zid Partner Dashboard
//   ZID_REDIRECT_URI                   https://<project>.supabase.co/functions/v1/zid?action=oauth_callback
//   APP_URL                            the address of the Carcass Trace website (for the "back to app" link)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ZID_API = "https://api.zid.sa/v1";
const ZID_OAUTH = "https://oauth.zid.sa";
const COMMENT_MAX = 100; // Zid limit per order comment
const COMMENTS_PER_ORDER = 20; // Zid limit per order

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const env = (k: string) => Deno.env.get(k) ?? "";
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function page(title: string, text: string) {
  const back = env("APP_URL") ? `<p><a href="${env("APP_URL")}">Back to Carcass Trace</a></p>` : "";
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px"><h2>${title}</h2><p>${text}</p>${back}</body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

type Conn = { authorization_token: string; access_token: string; store_id: string | null };

async function getConn(): Promise<Conn> {
  const { data } = await admin().from("zid_connection").select("*").eq("id", 1).maybeSingle();
  if (!data?.access_token) throw new Error("Zid is not connected yet. Open Settings and connect Zid.");
  return data as Conn;
}

// Zid's docs show two header styles (manager endpoints vs product endpoints); send both.
function zidHeaders(c: Conn) {
  const auth = c.authorization_token.startsWith("Bearer ") ? c.authorization_token : `Bearer ${c.authorization_token}`;
  const h: Record<string, string> = {
    "Authorization": auth,
    "X-Manager-Token": c.access_token,
    "Access-Token": c.access_token,
    "Role": "Manager",
    "Accept-Language": "en",
    "Content-Type": "application/json",
  };
  if (c.store_id) h["Store-Id"] = c.store_id;
  return h;
}

async function zid(c: Conn, path: string, init: RequestInit = {}) {
  const res = await fetch(ZID_API + path, { ...init, headers: { ...zidHeaders(c), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" && body ? (body.message?.description ?? body.message ?? JSON.stringify(body)) : text;
    throw new Error(`Zid replied ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  return body;
}

const pickName = (n: any) => typeof n === "string" ? n : (n?.en || n?.ar || "");

// Split "A: x | B: y | ..." into comments of at most 100 characters, breaking between products
export function splitComment(summary: string, prefix = "Trace: "): string[] {
  const parts = summary.split(" | ").map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    const piece = p.length + prefix.length > COMMENT_MAX ? p.slice(0, COMMENT_MAX - prefix.length) : p;
    const next = cur ? `${cur} | ${piece}` : piece;
    if ((prefix + next).length <= COMMENT_MAX) cur = next;
    else { out.push(prefix + cur); cur = piece; }
  }
  if (cur) out.push(prefix + cur);
  return out.slice(0, COMMENTS_PER_ORDER);
}

async function handleOAuth(url: URL) {
  const code = url.searchParams.get("code");
  if (!code) return page("Zid not connected", "Zid did not send an authorization code. Try connecting again from Settings.");
  const res = await fetch(`${ZID_OAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: env("ZID_CLIENT_ID"),
      client_secret: env("ZID_CLIENT_SECRET"),
      redirect_uri: env("ZID_REDIRECT_URI"),
      code,
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) {
    return page("Zid not connected", `Zid refused the connection (${res.status}). Check the client ID, secret and redirect address.`);
  }
  const conn: Conn = { authorization_token: tok.Authorization ?? tok.authorization ?? "", access_token: tok.access_token, store_id: null };
  try {
    const prof = await zid(conn, "/managers/account/profile");
    conn.store_id = String(prof?.user?.store?.id ?? "") || null;
  } catch { /* store id is only needed for the product list; it can be set later */ }
  await admin().from("zid_connection").upsert({
    id: 1,
    authorization_token: conn.authorization_token,
    access_token: conn.access_token,
    refresh_token: tok.refresh_token ?? null,
    store_id: conn.store_id,
    expires_at: tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  return page("Zid connected", "Carcass Trace can now read your products and orders and add comments to orders.");
}

async function syncProducts(c: Conn) {
  const db = admin();
  let pageNo = 1, total = 0;
  for (;;) {
    const body = await zid(c, `/products/?page=${pageNo}&page_size=50`);
    const items: any[] = body?.results ?? body?.products ?? body?.data ?? [];
    if (!items.length) break;
    const rows = items.map((p) => ({
      zid_product_id: String(p.id),
      name: pickName(p.name) || p.sku || String(p.id),
      name_ar: typeof p.name === "object" ? (p.name?.ar ?? null) : null,
      sku: p.sku ?? null,
      barcode: p.barcode || null,
      updated_at: new Date().toISOString(),
    }));
    // Only Zid-owned fields are written, so species, weight and shelf life set in the shop stay as they are
    const { error } = await db.from("products").upsert(rows, { onConflict: "zid_product_id" });
    if (error) throw new Error(error.message);
    total += rows.length;
    if (!body?.next && items.length < 50) break;
    pageNo++;
    if (pageNo > 200) break;
  }
  return { synced: total };
}

async function getOrder(c: Conn, orderId: string) {
  const body = await zid(c, `/managers/store/orders/${encodeURIComponent(orderId)}/view`);
  const o = body?.order ?? body;
  return {
    id: String(o.id),
    code: o.code ?? null,
    customer: o.customer?.name ?? null,
    status: o.order_status?.name ?? o.order_status?.code ?? null,
    products: (o.products ?? []).map((p: any) => ({
      zid_product_id: String(p.id),
      sku: p.sku ?? null,
      barcode: p.barcode ?? null,
      name: pickName(p.name),
      quantity: Number(p.quantity ?? 1),
    })),
  };
}

async function postComment(c: Conn, orderRef: string) {
  const db = admin();
  const { data: order } = await db.from("orders").select("*").eq("ref", orderRef).maybeSingle();
  if (!order?.trace_summary) throw new Error(`No packed items recorded for order ${orderRef}`);
  const comments = splitComment(order.trace_summary);
  for (const comment of comments) {
    await zid(c, `/managers/store/orders/${encodeURIComponent(orderRef)}/add-order-comment`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    });
  }
  await db.from("orders").update({ zid_comment_posted: true }).eq("ref", orderRef);
  return { posted: comments };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const action = url.searchParams.get("action");
      if (action === "oauth_start") {
        const q = new URLSearchParams({ client_id: env("ZID_CLIENT_ID"), redirect_uri: env("ZID_REDIRECT_URI"), response_type: "code" });
        return Response.redirect(`${ZID_OAUTH}/oauth/authorize?${q}`, 302);
      }
      if (action === "oauth_callback" || url.searchParams.has("code")) return await handleOAuth(url);
      return json({ error: "Unknown request" }, 400);
    }

    // Everything below needs a signed-in staff member
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const { data: who } = await createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")).auth.getUser(jwt);
    if (!who?.user) return json({ error: "Please sign in again." }, 401);

    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "status": {
        const { data } = await admin().from("zid_connection").select("store_id, expires_at, updated_at").eq("id", 1).maybeSingle();
        return json({ connected: !!data, ...data });
      }
      case "sync_products": return json(await syncProducts(await getConn()));
      case "get_order": return json(await getOrder(await getConn(), String(body.order_id ?? "").trim()));
      case "post_comment": return json(await postComment(await getConn(), String(body.order_ref ?? "").trim()));
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
