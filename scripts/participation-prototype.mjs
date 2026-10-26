import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production") {
  throw new Error("This throwaway prototype is disabled in production.");
}

const port = Number(process.argv[2] ?? 8897);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Supply a valid loopback port, or 0 to allocate one.");
}
const page = fileURLToPath(new URL("../display/participation-prototype.html", import.meta.url));
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (request.method !== "GET" || !["/", "/participation-prototype.html", "/health"].includes(path)) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  if (path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"ready":true,"prototype":true}');
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readFileSync(page));
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Throwaway participation mockups: http://127.0.0.1:${server.address().port}/?variant=A&view=compare`);
});
