// Reads a Google Sheet as CSV for the app's spreadsheet import (browsers can't fetch it directly).
// Only for signed-in people, only Google Sheets addresses (nothing else on the internet), and only
// sheets shared as "Anyone with the link can view". Limited to 5 MB.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { error: "Sign in first." });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return reply(401, { error: "Sign in first." });

  const { url } = await req.json().catch(() => ({}));
  const match = typeof url === "string" && url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (!match) return reply(400, { error: "That isn't a Google Sheets link (it should start with https://docs.google.com/spreadsheets/d/)." });
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0"; // which tab
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`, { redirect: "follow" });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("text/html")) {
    return reply(400, { error: "Couldn't read that sheet. In Google Sheets, use Share → General access → \"Anyone with the link\" (Viewer), then try again." });
  }
  const text = await res.text();
  if (text.length > 5_000_000) return reply(400, { error: "That sheet is too big to import at once (over 5 MB)." });
  return reply(200, { csv: text });
});
