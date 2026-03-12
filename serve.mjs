import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4025;

createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(join(__dirname, "index.html")));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Serving on http://127.0.0.1:${PORT}`);
});
