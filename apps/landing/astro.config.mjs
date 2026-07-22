import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { BASE_PATH, SITE_ORIGIN } from "./site.config.mjs";

export default defineConfig({
  integrations: [react()],
  site: SITE_ORIGIN,
  base: BASE_PATH,
  output: "static",
  trailingSlash: "always",
  compressHTML: true,
  build: {
    assets: "assets",
  },
});
