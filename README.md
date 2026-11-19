# Aqua Ding

A water tracker with an animated bottle and a loud ding reminder. Static PWA served by Cloudflare Workers (static assets).

- `public/` is the whole app (`index.html`, manifest, service worker, icons).
- `wrangler.jsonc` deploys `public/` as the Worker named `aquading`.
- Deploy: push to `main`; Cloudflare builds with `npx wrangler deploy`.
