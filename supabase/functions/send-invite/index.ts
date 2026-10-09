// Emails an invite: "<someone> invited you to join <brewery> on Brewery OS".
//
// The app calls this right after saving an invite (and from "Email again"). Who may send is
// decided by the database: the invite is read with the caller's own sign-in, so the security
// rules only let a brewery's admins see (and so email) its invites. Anyone else gets "not found".
//
// The email carries no sign-in link or code. It says where to go and which address to sign in
// with; signing in proves they own the address, and the app then joins them to the brewery.
// That works the same for people with and without an account. It also carries the invite's join
// code, for someone who signs in with a different address (see migrations/..._join_codes.sql).
// Sending it makes the code work for another 14 days.
//
// Settings (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY   required; without it nothing is sent and the app says so
//   APP_URL          the app's address (default https://brew.chrisbohn.org)
//   INVITE_FROM      sender (default "Brewery OS <noreply@brew.chrisbohn.org>")
//   RESEND_API_URL   only for tests (default https://api.resend.com/emails)
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const LEVELS: Record<string, string> = {
  viewer: "Viewer", taproom: "Taproom", cellar: "Cellar", brewer: "Brewer", head_brewer: "Head brewer", admin: "Admin",
};
// Don't send the same invite again within this many minutes (a double tap, an impatient retry)
const RESEND_AFTER_MINUTES = 2;

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function esc(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  const auth = req.headers.get("Authorization");
  if (!auth) return reply(401, { error: "Sign in first." });
  const { inviteId } = await req.json().catch(() => ({}));
  if (typeof inviteId !== "string") return reply(400, { error: "Which invite?" });

  // Everything below runs as the person who called, under the database's security rules
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: invite, error } = await db.from("invites")
    .select("id, email, role, code, emailed_at, breweries(name)").eq("id", inviteId).maybeSingle();
  if (error) return reply(500, { error: error.message });
  if (!invite) return reply(404, { error: "That invite doesn't exist, or you can't send it." });
  if (invite.emailed_at && Date.now() - Date.parse(invite.emailed_at) < RESEND_AFTER_MINUTES * 60_000) {
    return reply(429, { error: "It was emailed a moment ago. Give it a few minutes to arrive." });
  }

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return reply(503, { error: "Invite emails aren't set up yet." });

  const { data: { user } } = await db.auth.getUser();
  const inviter = user?.email ?? "Someone";
  const brewery = (invite.breweries as { name: string } | null)?.name ?? "a brewery";
  const level = LEVELS[invite.role] ?? invite.role;
  const app = Deno.env.get("APP_URL") ?? "https://brew.chrisbohn.org";
  const subject = `You're invited to join ${brewery} on Brewery OS`;
  const text = [
    `${inviter} invited you to join ${brewery} on Brewery OS, as ${level}.`,
    "",
    `To join, open ${app} and sign in with this email address (${invite.email}).`,
    "You'll get a sign-in code by email, and you'll join the brewery automatically.",
    "",
    `Signing in with a different email? Choose "Yes, I'm joining my team" and type this join code: ${invite.code}`,
    "(It works once, for the next 14 days.)",
    "",
    "If you weren't expecting this, you can ignore it.",
  ].join("\n");
  const html = `<p>${esc(inviter)} invited you to join <strong>${esc(brewery)}</strong> on Brewery OS, as ${esc(level)}.</p>
<p><a href="${esc(app)}" style="display:inline-block;padding:10px 18px;background:#1f1c18;color:#fff;border-radius:8px;text-decoration:none">Open Brewery OS</a></p>
<p>Sign in with this email address (<strong>${esc(invite.email)}</strong>). You'll get a sign-in code by email, and you'll join the brewery automatically.</p>
<p>Signing in with a different email? Choose <strong>Yes, I'm joining my team</strong> and type this join code:<br>
<strong style="font-family:monospace;font-size:1.2em">${esc(invite.code)}</strong><br><span style="color:#777">(It works once, for the next 14 days.)</span></p>
<p style="color:#777">If you weren't expecting this, you can ignore it.</p>`;

  const sent = await fetch(Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("INVITE_FROM") ?? "Brewery OS <noreply@brew.chrisbohn.org>",
      to: [invite.email], reply_to: user?.email, subject, text, html,
    }),
  }).catch((e) => ({ ok: false, status: 0, text: () => Promise.resolve(String(e)) }) as Response);
  if (!sent.ok) {
    console.error("email provider refused", sent.status, await sent.text());
    return reply(502, { error: "The email service didn't accept it. Try again in a little while." });
  }

  await db.from("invites").update({ emailed_at: new Date().toISOString() }).eq("id", invite.id);
  return reply(200, { sent: true });
});
