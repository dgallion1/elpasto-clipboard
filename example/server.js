import express from "express";

const app = express();
const PORT = process.env.PORT || 9000;

// Simple in-memory data
const tasks = [
  { id: 1, title: "Test the tunnel", done: false },
  { id: 2, title: "Share with a friend", done: false },
  { id: 3, title: "Try from mobile", done: true },
];

// Layout helper
function page(title, nav, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Tunnel Demo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; }
    nav { background: #171717; border-bottom: 1px solid #262626; padding: 1rem 2rem; display: flex; gap: 1.5rem; align-items: center; }
    nav a { color: #a3a3a3; text-decoration: none; font-size: 0.9rem; }
    nav a:hover, nav a.active { color: #fff; }
    nav .brand { color: #fff; font-weight: 700; margin-right: auto; }
    main { max-width: 48rem; margin: 2rem auto; padding: 0 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #a3a3a3; line-height: 1.6; margin-bottom: 1rem; }
    .card { background: #171717; border: 1px solid #262626; border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .badge-green { background: #052e16; color: #4ade80; }
    .badge-yellow { background: #422006; color: #facc15; }
    .task-list { list-style: none; }
    .task-list li { padding: 0.75rem 0; border-bottom: 1px solid #262626; display: flex; justify-content: space-between; }
    .task-list li:last-child { border-bottom: none; }
    .done { text-decoration: line-through; color: #525252; }
    a.btn { display: inline-block; background: #2563eb; color: #fff; padding: 0.5rem 1rem; border-radius: 0.375rem; text-decoration: none; font-size: 0.9rem; }
    a.btn:hover { background: #1d4ed8; }
    pre { background: #171717; border: 1px solid #262626; border-radius: 0.5rem; padding: 1rem; overflow-x: auto; font-size: 0.85rem; color: #a3a3a3; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  ${nav}
  <main>${body}</main>
</body>
</html>`;
}

function nav(active) {
  const links = [
    ["/", "Home"],
    ["/about", "About"],
    ["/dashboard", "Dashboard"],
    ["/api/tasks", "API"],
  ];
  const items = links
    .map(([href, label]) => `<a href="${href}"${active === href ? ' class="active"' : ""}>${label}</a>`)
    .join("");
  return `<nav><span class="brand">Tunnel Demo</span>${items}</nav>`;
}

// Routes
app.get("/", (_req, res) => {
  res.send(
    page("Home", nav("/"), `
      <h1>Welcome to the Tunnel Demo</h1>
      <p>This is a multi-route Express app for testing <code>elpasto-tunnel</code>. Navigate around using the links above to verify that routing, relative URLs, and page transitions all work through the tunnel.</p>
      <div class="stats">
        <div class="card">
          <h2>Routes</h2>
          <p style="font-size:2rem;color:#fff;margin:0">4</p>
        </div>
        <div class="card">
          <h2>Tasks</h2>
          <p style="font-size:2rem;color:#fff;margin:0">${tasks.length}</p>
        </div>
        <div class="card">
          <h2>Status</h2>
          <p style="margin:0"><span class="badge badge-green">Running</span></p>
        </div>
      </div>
      <a class="btn" href="/dashboard">Go to Dashboard</a>
    `)
  );
});

app.get("/about", (_req, res) => {
  res.send(
    page("About", nav("/about"), `
      <h1>About</h1>
      <p>This demo app exists to test <strong>elpasto-tunnel</strong> — the WebRTC HTTP tunnel built into elPasto.</p>
      <div class="card">
        <h2>How it works</h2>
        <p>The <code>elpasto-tunnel</code> CLI joins an elPasto session as a WebRTC peer and proxies HTTP requests from browsers in the session to this local server. The browser's service worker intercepts requests to <code>/tunnel/{peerId}/</code> and routes them through the WebRTC data channel.</p>
      </div>
      <div class="card">
        <h2>What to test</h2>
        <p>Navigate between pages, check the API endpoint, and verify the dashboard renders correctly. All of these exercise different aspects of the tunnel: HTML responses, JSON APIs, relative link resolution, and dynamic content.</p>
      </div>
    `)
  );
});

app.get("/dashboard", (_req, res) => {
  const done = tasks.filter((t) => t.done).length;
  const pending = tasks.length - done;
  res.send(
    page("Dashboard", nav("/dashboard"), `
      <h1>Dashboard</h1>
      <div class="stats">
        <div class="card">
          <h2>Total</h2>
          <p style="font-size:2rem;color:#fff;margin:0">${tasks.length}</p>
        </div>
        <div class="card">
          <h2>Done</h2>
          <p style="font-size:2rem;color:#4ade80;margin:0">${done}</p>
        </div>
        <div class="card">
          <h2>Pending</h2>
          <p style="font-size:2rem;color:#facc15;margin:0">${pending}</p>
        </div>
      </div>
      <div class="card">
        <h2>Tasks</h2>
        <ul class="task-list">
          ${tasks.map((t) => `<li><span class="${t.done ? "done" : ""}">${t.title}</span> <span class="badge ${t.done ? "badge-green" : "badge-yellow"}">${t.done ? "done" : "pending"}</span></li>`).join("")}
        </ul>
      </div>
    `)
  );
});

app.get("/api/tasks", (_req, res) => {
  res.json({ tasks, meta: { total: tasks.length, timestamp: new Date().toISOString() } });
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
  }, 1000);
  req.on("close", () => clearInterval(interval));
});

app.listen(PORT, () => {
  console.log(`Tunnel demo listening on http://localhost:${PORT}`);
});
