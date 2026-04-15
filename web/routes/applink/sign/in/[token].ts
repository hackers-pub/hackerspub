import { escape } from "@std/html/entities";
import { define } from "../../../../utils.ts";

export const handler = define.handlers((ctx) => {
  const { token } = ctx.params;

  const code = ctx.url.searchParams.get("code");
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
    <a href="${escape(appLink)}" class="btn btn-primary">Open in app</a>
  </div>
  <div style="margin-top: 8px;">
    <a href="${
    escape(webFallback)
  }" class="btn btn-secondary">Continue in browser</a>
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
