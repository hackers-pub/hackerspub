import type { APIEvent } from "@solidjs/start/server";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function GET({ params, request }: APIEvent) {
  const { token } = params;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code == null) {
    return new Response("Missing code", { status: 400 });
  }

  const appLink = `hackerspub://verify?token=${
    encodeURIComponent(token)
  }&code=${encodeURIComponent(code)}`;
  const webFallback = `/sign/in/${encodeURIComponent(token)}?code=${
    encodeURIComponent(code)
  }&platform=web`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hackers' Pub</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .container {
    text-align: center;
    padding: 24px;
  }
  .btn {
    display: inline-block;
    padding: 14px 32px;
    border-radius: 9999px;
    text-decoration: none;
    font-size: 16px;
    font-weight: 600;
    margin: 8px;
  }
  .btn-primary {
    background: #18181b;
    color: #fff;
  }
  .btn-secondary {
    background: #f4f4f5;
    color: #18181b;
  }
</style>
</head>
<body>
<script>
  var appLink = ${JSON.stringify(appLink)};
  try { window.location.href = appLink; } catch(e) {}
</script>
<div class="container">
  <p>Sign in to Hackers' Pub</p>
  <div>
    <a href="${escapeHtml(appLink)}" class="btn btn-primary">Open in app</a>
  </div>
  <div style="margin-top: 8px;">
    <a href="${
    escapeHtml(webFallback)
  }" class="btn btn-secondary">Continue in browser</a>
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
