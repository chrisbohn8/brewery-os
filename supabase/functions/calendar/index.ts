// The planning calendar as a calendar feed (iCalendar), for Google or Apple Calendar to subscribe to.
//
// GET /functions/v1/calendar?t=<the link's secret>
// Calendar apps fetch this on their own, without signing in, so the link's secret is what lets
// them in (made and turned off in Settings → My account). The database decides what it shows
// (calendar_feed in migrations/..._calendar_feeds.sql): nothing for a wrong, turned-off, or
// orphaned link. Read-only and one-way: nothing here changes anything.
//
// Settings (secrets): SUPABASE_DB_URL (provided by Supabase), APP_URL (default https://brew.chrisbohn.org).
import { Pool } from "jsr:@db/postgres@0.19.5";

const pool = new Pool(Deno.env.get("SUPABASE_DB_URL")!, 2, true);

// iCalendar text: escape \ ; , and newlines; fold long lines at 75 characters
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string) {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 75) {
    out.push(rest.slice(0, 75));
    rest = " " + rest.slice(75);
  }
  out.push(rest);
  return out.join("\r\n");
}
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const nextDay = (d: Date) => new Date(d.getTime() + 86400000);

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Use GET.", { status: 405 });
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^cal_[0-9a-f]{48}$/.test(token)) return new Response("Not found.", { status: 404 });

  const client = await pool.connect();
  try {
    const rows = (await client.queryObject<{ brewery_name: string; day: Date; title: string; detail: string; uid: string }>`
      select brewery_name, day, title, detail, uid from public.calendar_feed(${token})`).rows;
    if (!rows.length) {
      // A link that works but has nothing planned yet still needs to look like a calendar; a link
      // that doesn't work gets "not found" (calendar_feed answers nothing for both, so check which)
      const known = (await client.queryObject<{ ok: boolean }>`
        select exists (select 1 from public.calendar_feeds where token_hash = encode(extensions.digest(${token}, 'sha256'), 'hex')
                         and revoked_at is null) as ok`).rows[0]?.ok;
      if (!known) return new Response("Not found.", { status: 404 });
    }
    const name = rows[0]?.brewery_name ?? "Brewery OS";
    const app = Deno.env.get("APP_URL") ?? "https://brew.chrisbohn.org";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Brewery OS//Planning calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      `X-WR-CALNAME:${icsText(`${name} plan`)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
      ...rows.flatMap((r) => [
        "BEGIN:VEVENT",
        `UID:${r.uid}@brewery-os`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ymd(r.day)}`,
        `DTEND;VALUE=DATE:${ymd(nextDay(r.day))}`,
        `SUMMARY:${icsText(r.title)}`,
        `DESCRIPTION:${icsText([r.detail, `Open Brewery OS: ${app}`].filter(Boolean).join("\n"))}`,
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
      ]),
      "END:VCALENDAR",
    ];
    return new Response(lines.map(fold).join("\r\n") + "\r\n", {
      headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error(e);
    return new Response("The calendar couldn't be made right now.", { status: 500 });
  } finally {
    client.release();
  }
});
