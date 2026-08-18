# Self-hosting — the one gotcha

OpenTakeoff's own production deploy is Netlify-only (see
[`DEPLOYMENT.md`](DEPLOYMENT.md)), and Netlify's CDN gets content types right
automatically. If you build `web/dist` yourself and serve it from your own
reverse proxy instead—nginx behind Docker or Tailscale, for example—there's
one gotcha worth knowing about before you run into it blind.

## `.mjs` served as `application/octet-stream`

`npm run build` emits some chunks as `.mjs` (ES modules). Stock nginx's
default `mime.types` file has no entry for `.mjs`—only `.js`—so it falls
back to `application/octet-stream`. Browsers enforce strict MIME checking on
`<script type="module">`, so the module is silently refused and the app fails
to load with no obvious error beyond the browser console.

**Fix—if you control `mime.types`:** add `mjs` to the existing
`application/javascript` line:

```nginx
# /etc/nginx/mime.types
types {
    application/javascript                          js mjs;
    ...
}
```

**Fix—if you're on a base image and don't want to fork `mime.types`**
(for example, a minimal `nginx:alpine` Docker image), override only this extension in
your server block instead—this doesn't touch the rest of the type table:

```nginx
location ~* \.mjs$ {
    default_type application/javascript;
}
```

Confirmed against a real self-hosted deployment (Docker + nginx + Tailscale)—not
hypothetical.
