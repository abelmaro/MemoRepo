import type { APIRoute } from "astro";
import { absoluteUrl } from "../../site.config.mjs";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\nSitemap: ${absoluteUrl("/sitemap.xml")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
