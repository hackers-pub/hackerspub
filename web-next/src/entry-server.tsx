// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html>
        <head>
          <meta charset="utf-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link
            rel="alternate icon"
            type="image/x-icon"
            href="/favicon.ico"
            sizes="16x16 32x32 48x48 256x256"
          />
          <link rel="apple-touch-icon" href="/apple-icon-180.png" />
          <link rel="manifest" href="/manifest.json" />
          <meta name="theme-color" content="#000000" />
          {assets}
        </head>
        <body>
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));
