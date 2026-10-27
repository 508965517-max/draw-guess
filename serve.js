// 纯静态文件服务器（无第三方依赖），用于在本机离线游玩 / 局域网访问。
// 用法： node serve.js   然后浏览器打开 http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const PORT = process.env.PORT || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const fp = path.join(root, p);
    // 防目录穿越
    if (!fp.startsWith(root)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(fp, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`你画我猜 已启动： http://localhost:${PORT}`));
