// Throwaway, loopback-only sketch server. Run: node .\display\workbench\meeting-emphasis-prototype.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./meeting-emphasis-prototype.html', import.meta.url));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path !== '/') {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  }).end(html);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`Throwaway meeting-emphasis sketches: http://127.0.0.1:${server.address().port}/?variant=A&compare=1`);
});
