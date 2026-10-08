// Alerts (Phase 6¾): run by the server every 15 minutes (a scheduled job calls this with a secret).
// 1. Brings every brewery's alerts up to date (check_alerts: new ones open, gone ones clear).
// 2. Emails each new alert once, to the people chosen for that kind (one email per person, listing
//    everything new), except during the brewery's quiet hours, when they wait.
// 3. Emails new problem reports from people's phones (see migrations/..._error_reports.sql) to
//    ERROR_REPORTS_TO, if it's set, and forgets reports over 90 days old.
//
// Settings (secrets): ALERTS_SECRET (required; the scheduled job sends it), RESEND_API_KEY,
// APP_URL, INVITE_FROM (sender), ERROR_REPORTS_TO (whoever fixes problems), RESEND_API_URL (tests only).
import { Pool, type PoolClient } from "jsr:@db/postgres@0.19.5";

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
    const problems = await emailProblemReports(client, key);
    return reply(200, { opened, emailed: sent, waiting: pending.length - done.length, problems });
  } catch (e) {
    console.error(e);
    return reply(500, { error: "The alert check didn't finish." });
  } finally {
    client.release();
  }
});

// New problem reports, in one email to whoever fixes problems (ERROR_REPORTS_TO)
async function emailProblemReports(client: PoolClient, key: string | undefined) {
  await client.queryObject`delete from public.error_reports where last_at < now() - interval '90 days'`;
  const to = Deno.env.get("ERROR_REPORTS_TO");
  if (!to || !key) return 0;
  const reports = (await client.queryObject<{
    id: string; message: string; stack: string; screen: string; app_version: string; browser: string;
    times: number; reported_at: Date; brewery: string | null; email: string | null;
  }>`select e.id, e.message, e.stack, e.screen, e.app_version, e.browser, e.times, e.reported_at,
            b.name as brewery, u.email
       from public.error_reports e
       left join public.breweries b on b.id = e.brewery_id
       left join auth.users u on u.id = e.user_id
      where e.emailed_at is null order by e.reported_at limit 50`).rows;
  if (!reports.length) return 0;
  const line = (r: typeof reports[number]) =>
    `${r.message}${r.times > 1 ? ` (${r.times} times)` : ""}\n  ${r.reported_at.toISOString()} · ${r.email ?? "signed out"} · ${r.brewery ?? "no brewery"} · ` +
    `screen: ${r.screen || "?"} · version ${r.app_version || "?"}\n  ${r.browser}${r.stack ? `\n  ${r.stack.split("\n").slice(0, 6).join("\n  ")}` : ""}`;
  const text = `${reports.length} new problem report${reports.length === 1 ? "" : "s"} from Brewery OS:\n\n${reports.map(line).join("\n\n")}`;
  const res = await fetch(Deno.env.get("RESEND_API_URL") ?? "https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("INVITE_FROM") ?? "Brewery OS <noreply@brew.chrisbohn.org>", to: [to],
      subject: `Brewery OS: ${reports.length} new problem report${reports.length === 1 ? "" : "s"}`,
      text, html: `<pre style="white-space:pre-wrap;font:13px ui-monospace,Menlo,monospace">${esc(text)}</pre>`,
    }),
  }).catch(() => null);
  if (!res?.ok) {
    console.error("problem report email not accepted", res?.status);
    return 0;
  }
  const ids = reports.map((r) => r.id);
  await client.queryObject`update public.error_reports set emailed_at = now() where id = any(${ids}::uuid[])`;
  return reports.length;
}
