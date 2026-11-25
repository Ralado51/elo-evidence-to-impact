/**
 * Local-only static HTTP server for Elo v3 browser accessibility checks.
 *
 * Binds strictly to 127.0.0.1 and serves only files resolved inside web/.
 * Rejects path traversal attempts (../, encoded traversal, backslashes, symlinks
 * escaping web/) with HTTP 403 and missing files with HTTP 404.
 * Node built-ins only; zero external dependencies.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function hasTraversalAttempt(rawUrlPath) {
  if (!rawUrlPath || !rawUrlPath.startsWith("/")) {
    return true;
  }
  const lower = rawUrlPath.toLowerCase();
  if (
    lower.includes("\0") ||
    lower.includes("%00") ||
    lower.includes("\\") ||
    lower.includes("%5c") ||
    lower.includes("%2e") ||
    lower.includes("..")
  ) {
    return true;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawUrlPath);
  } catch {
    return true;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return true;
  }
  const segments = decoded.split("/");
  if (segments.some((seg) => seg === ".." || seg === ".")) {
    return true;
  }
  return false;
}

function isInsideRoot(candidatePath, rootRealPath) {
  return (
    candidatePath === rootRealPath ||
    candidatePath.startsWith(rootRealPath + path.sep)
  );
}

/**
 * Start a loopback-only static HTTP server rooted at webRoot.
 * @param {string} webRoot
 */
export async function startLocalWebServer(webRoot) {
  const realWebRoot = await fs.realpath(path.resolve(webRoot));

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed");
        return;
      }

      const rawUrl = req.url || "/";
      const queryIndex = rawUrl.indexOf("?");
      const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);

      if (hasTraversalAttempt(rawPath)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const decodedPath = decodeURIComponent(rawPath);
      const relativePath = decodedPath.replace(/^\/+/, "");
      if (!relativePath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const candidate = path.resolve(realWebRoot, relativePath);
      if (!isInsideRoot(candidate, realWebRoot)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      let realCandidate;
      try {
        realCandidate = await fs.realpath(candidate);
      } catch (err) {
        if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
        throw err;
      }

      if (!isInsideRoot(realCandidate, realWebRoot)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const stat = await fs.stat(realCandidate);
      if (!stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(realCandidate).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const body = await fs.readFile(realCandidate);

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(body);
      }
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to resolve bound server address.");
  }

  const host = addr.address;
  const port = addr.port;
  const origin = `http://${host}:${port}`;

  return {
    host,
    port,
    origin,
    webRoot: realWebRoot,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function sendRawGet(host, port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: "GET",
        path: rawPath,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({ path: rawPath, status: res.statusCode || 0 });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Verify that path-traversal and outside-web/ requests are blocked (403/404).
 */
export async function probeServerIsolation(host, port) {
  const probes = [
    "/../README.md",
    "/%2e%2e/README.md",
    "/v3/../../README.md",
    "/etc/passwd",
  ];
  const results = [];
  const failures = [];
  for (const probePath of probes) {
    const res = await sendRawGet(host, port, probePath);
    const blocked = res.status === 403 || res.status === 404;
    results.push({ path: res.path, status: res.status, blocked });
    if (!blocked) {
      failures.push(
        `Server did not block outside/traversal path ${res.path} (HTTP ${res.status})`
      );
    }
  }
  return {
    passed: failures.length === 0,
    host,
    probes: results,
    failures,
  };
}
