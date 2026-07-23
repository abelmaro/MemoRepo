/// <reference types="astro/client" />

declare module "../../site.config.mjs" {
  export const SITE_ORIGIN: string;
  export const BASE_PATH: string;
  export const CANONICAL_URL: string;
  export function withBase(path?: string): string;
  export function absoluteUrl(path?: string): string;
}
