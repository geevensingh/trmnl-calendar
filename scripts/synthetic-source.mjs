import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[2] ?? 8899);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Supply a valid local port.");
}
let redirect = false;

function syntheticCalendar() {
  const now = new Date();
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  const primary = new Date(`${localDate}T12:00:00Z`);
  while ([0, 6].includes(primary.getUTCDay())) primary.setUTCDate(primary.getUTCDate() + 1);
  const secondary = new Date(primary);
  do secondary.setUTCDate(secondary.getUTCDate() + 1);
  while ([0, 6].includes(secondary.getUTCDay()));
  const day = date => date.toISOString().slice(0, 10).replaceAll("-", "");
  const instant = date => date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const firstTiming = primary.toISOString().slice(0, 10) === localDate
    ? `DTSTART:${instant(new Date(now.getTime() - 15 * 60_000))}\r\nDTEND:${instant(new Date(now.getTime() + 45 * 60_000))}`
    : `DTSTART;TZID=America/Los_Angeles:${day(primary)}T090000\r\nDTEND;TZID=America/Los_Angeles:${day(primary)}T100000`;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TRMNL Calendar//Synthetic demonstration//EN",
    "BEGIN:VEVENT", "UID:demo-primary@synthetic.invalid", `DTSTAMP:${instant(now)}`, firstTiming,
    "SUMMARY:Synthetic source meeting", "LOCATION:Demo studio",
    "DESCRIPTION:Synthetic description must not leave the adapter.", "END:VEVENT",
    "BEGIN:VEVENT", "UID:demo-secondary@synthetic.invalid", `DTSTAMP:${instant(now)}`,
    `DTSTART;TZID=America/Los_Angeles:${day(secondary)}T110000`,
    `DTEND;TZID=America/Los_Angeles:${day(secondary)}T120000`,
    "SUMMARY:Secondary working-day meeting", "END:VEVENT", "END:VCALENDAR", ""
  ].join("\r\n");
}

createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (request.method === "POST" && path === "/fail-source") {
    redirect = true;
    response.writeHead(204).end();
  } else if (path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"ready":true}');
  } else if (path === "/calendar.ics" && redirect) {
    response.writeHead(302, { Location: "/replacement.ics" }).end();
  } else if (path === "/calendar.ics" || path === "/replacement.ics") {
    response.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" }).end(syntheticCalendar());
  } else {
    const preview = path === "/" ? "demo.html"
      : /^\/demo-(og|x)-(full|half_horizontal|half_vertical)\.html$/.test(path) ? path.slice(1) : null;
    const isAsset = /^\/(css|js)\/3\.4\.3\/plugins\.(css|js)$/.test(path)
      || /^\/fonts\/[A-Za-z0-9_-]+\.(ttf|woff2?)$/.test(path);
    if (!preview && !isAsset) {
      response.writeHead(404).end();
      return;
    }
    const file = preview ? join(root, "artifacts", preview)
      : join(root, ".tools", "framework", ...path.slice(1).split("/"));
    try {
      const contentType = preview ? "text/html; charset=utf-8"
        : path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "application/javascript"
        : path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".woff") ? "font/woff" : "font/ttf";
      response.writeHead(200, { "Content-Type": contentType }).end(readFileSync(file));
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
      if (error.code !== "ENOENT") console.error("Synthetic preview file failure.");
    }
  }
}).listen(port, "127.0.0.1", () => console.log("Synthetic source and preview ready."));
