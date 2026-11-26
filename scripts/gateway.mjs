// Local gateway for manual testing: serves web/v3 at /v3/*, landing at /, proxies /api/v3/* to the API.
// Usage: node scripts/gateway.mjs <repo-root> <port> [api-port]
import fs from "node:fs"; import http from "node:http"; import path from "node:path";
const root = path.resolve(process.argv[2] || "."); const port = +process.argv[3] || 8080; const apiPort = +process.argv[4] || 8000;
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".task": "application/octet-stream" };
function serve(res, base, rel) {
  const f = path.join(base, rel || "index.html");
  if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("404"); return; }
  res.writeHead(200, { "content-type": mime[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/v3/")) {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!["host", "content-length"].includes(k) && typeof v === "string") headers[k] = v;
      const r = await fetch(`http://127.0.0.1:${apiPort}${u.pathname}${u.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(502); res.end("API indisponível: " + e.message); }
    return;
  }
  if (u.pathname.startsWith("/v3/")) return serve(res, path.join(root, "web", "v3"), u.pathname.slice(4));
  if (u.pathname === "/" || u.pathname === "/index.html") return serve(res, path.join(root, "landing"), "index.html");
  res.writeHead(404); res.end("404");
}).listen(port, "127.0.0.1", () => console.log(`gateway http://127.0.0.1:${port}`));
