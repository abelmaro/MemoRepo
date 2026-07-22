import type { APIRoute } from "astro";
import { withBase } from "../../site.config.mjs";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      name: "MemoRepo",
      short_name: "MemoRepo",
      description: "Local-first, read-only code intelligence for coding agents.",
      start_url: withBase("/"),
      scope: withBase("/"),
      display: "standalone",
      background_color: "#090b0d",
      theme_color: "#090b0d",
      icons: [
        { src: withBase("/android-chrome-192x192.png"), sizes: "192x192", type: "image/png" },
        { src: withBase("/android-chrome-512x512.png"), sizes: "512x512", type: "image/png" },
      ],
    }),
    { headers: { "content-type": "application/manifest+json; charset=utf-8" } },
  );
