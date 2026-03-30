// Lightweight static server for www + providers subdomains
// Port 4026 — serves different content based on hostname

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PORT = 4026;
const HOST = "127.0.0.1";
const PUBLIC = join(import.meta.dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function getMime(path) {
  const ext = path.match(/\.[^.]+$/)?.[0] || "";
  return MIME[ext] || "application/octet-stream";
}

const server = createServer(async (req, res) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  const url = new URL(req.url, `http://${host}`);
  let pathname = url.pathname;

  // Route based on hostname
  if (host.startsWith("providers")) {
    // Serve provider landing page (reuse current index.html)
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }
  } else {
    // www / bare domain — serve agent landing page
    if (pathname === "/" || pathname === "") {
      pathname = "/agent-landing.html";
    }
  }

  // Security: no path traversal
  const safePath = join(PUBLIC, pathname.replace(/\.\./g, ""));
  if (!safePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(safePath);
    res.writeHead(200, { "Content-Type": getMime(safePath) });
    res.end(data);
  } catch {
    // Try with .html extension
    try {
      const htmlPath = safePath + ".html";
      const data = await readFile(htmlPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WWW/Providers server on http://${HOST}:${PORT}`);
});
