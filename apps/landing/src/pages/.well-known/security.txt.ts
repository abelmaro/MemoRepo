import type { APIRoute } from "astro";
import { absoluteUrl } from "../../../site.config.mjs";

export const prerender = true;

export const GET: APIRoute = () => {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return new Response(
    [
      "Contact: https://github.com/abelmaro/MemoRepo/security/advisories/new",
      "Policy: https://github.com/abelmaro/MemoRepo/security/policy",
      `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
      `Expires: ${expires}`,
      "Preferred-Languages: en",
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
};
