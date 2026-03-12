import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname, extname } from "path";
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
};

createServer((req, res) => {
  let pathname = req.url.split("?")[0];
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const filePath = join(__dirname, pathname);
  const ext = extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";

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
