import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4025;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
};

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

createServer((req, res) => {
  // Only allow GET and HEAD methods
  if (req.method !== "GET" && req.method !== "HEAD") {
    setSecurityHeaders(res);
    res.writeHead(405, { "Content-Type": "text/plain", "Allow": "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  let pathname = req.url.split("?")[0];
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  // Path traversal protection: resolve and ensure it stays within __dirname
  const filePath = resolve(join(__dirname, pathname));
  if (!filePath.startsWith(__dirname)) {
    setSecurityHeaders(res);
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";

  setSecurityHeaders(res);
  if (existsSync(filePath)) {
    res.writeHead(200, { "Content-Type": contentType });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(__dirname, "index.html")));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Serving on http://127.0.0.1:${PORT}`);
});
