// Alerts (Phase 6¾): run by the server every 15 minutes (a scheduled job calls this with a secret).
// 1. Brings every brewery's alerts up to date (check_alerts: new ones open, gone ones clear).
// 2. Emails each new alert once, to the people chosen for that kind (one email per person, listing
//    everything new), except during the brewery's quiet hours, when they wait.
//
// Settings (secrets): ALERTS_SECRET (required; the scheduled job sends it), RESEND_API_KEY,
// APP_URL, INVITE_FROM (sender), RESEND_API_URL (tests only).
import { Pool } from "jsr:@db/postgres@0.19.5";

const pool = new Pool(Deno.env.get("SUPABASE_DB_URL")!, 2, true);
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

Deno.serve(async (req) => {
  const secret = Deno.env.get("ALERTS_SECRET");
  if (!secret || req.headers.get("x-alerts-secret") !== secret) return reply(401, { error: "Not allowed." });
  const client = await pool.connect();
  try {
    const opened = (await client.queryObject<{ n: number }>`select public.check_alerts(null) as n`).rows[0].n;
    // Alerts not yet emailed, with who should get them and whether it's quiet hours at that brewery
    const pending = (await client.queryObject<{
      id: string; brewery: string; title: string; detail: string; emails: string[] | null; quiet: boolean;
    }>`select a.id, br.name as brewery, a.title, a.detail,
              (select array_agg(u.email) from auth.users u where u.id = any(r.recipients)
                 and exists (select 1 from public.memberships m where m.brewery_id = a.brewery_id and m.user_id = u.id)) as emails,
              case when br.alert_quiet_start is null or br.alert_quiet_end is null then false
                   when br.alert_quiet_start < br.alert_quiet_end
                     then extract(hour from now() at time zone br.time_zone) between br.alert_quiet_start and br.alert_quiet_end - 1
                   else extract(hour from now() at time zone br.time_zone) >= br.alert_quiet_start
                     or extract(hour from now() at time zone br.time_zone) < br.alert_quiet_end end as quiet
         from public.alerts a join public.breweries br on br.id = a.brewery_id
         left join public.alert_rules r on r.brewery_id = a.brewery_id and r.kind = a.kind
        where a.notified_at is null and a.resolved_at is null and a.acknowledged_at is null
        order by a.opened_at`).rows;

    // One email per person per brewery, listing what's new
    const outbox = new Map<string, { brewery: string; to: string; alerts: typeof pending }>();
    const done: string[] = [];
    for (const a of pending) {
      if (a.quiet) continue; // wait for the quiet hours to end
      done.push(a.id); // emailed now, or nobody chosen to email
      for (const to of a.emails ?? []) {
        const key = `${a.brewery}|${to}`;
        if (!outbox.has(key)) outbox.set(key, { brewery: a.brewery, to, alerts: [] });
        outbox.get(key)!.alerts.push(a);
      }
    }
    const key = Deno.env.get("RESEND_API_KEY");
    const app = Deno.env.get("APP_URL") ?? "https://brew.chrisbohn.org";
    let sent = 0;
    for (const { brewery, to, alerts } of outbox.values()) {
      if (!key) break;
      const subject = alerts.length === 1 ? `${brewery}: ${alerts[0].title}` : `${brewery}: ${alerts.length} new alerts`;
      const text = [...alerts.map((a) => `• ${a.title}${a.detail ? `\n  ${a.detail}` : ""}`), "", `Open Brewery OS: ${app}`,
        "", "You get these because you're chosen for these alerts in Settings → Alerts."].join("\n");
      const html = `<ul>${alerts.map((a) => `<li><strong>${esc(a.title)}</strong>${a.detail ? `<br><span style="color:#555">${esc(a.detail)}</span>` : ""}</li>`).join("")}</ul>
        <p><a href="${esc(app)}">Open Brewery OS</a></p><p style="color:#777">You get these because you're chosen for these alerts in Settings → Alerts.</p>`;
      const res = await fetch(Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: Deno.env.get("INVITE_FROM") ?? "Brewery OS <noreply@brew.chrisbohn.org>", to: [to], subject, text, html }),
      }).catch(() => null);
      if (res?.ok) sent++;
      else console.error("alert email not accepted", to, res?.status);
    }
    if (done.length) await client.queryObject`update public.alerts set notified_at = now() where id = any(${done}::uuid[])`;
    return reply(200, { opened, emailed: sent, waiting: pending.length - done.length });
  } catch (e) {
    console.error(e);
    return reply(500, { error: "The alert check didn't finish." });
  } finally {
    client.release();
  }
});
