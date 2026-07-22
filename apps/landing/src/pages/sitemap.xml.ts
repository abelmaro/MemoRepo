import type { APIRoute } from "astro";
import { CANONICAL_URL } from "../../site.config.mjs";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${CANONICAL_URL}</loc></url></urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
