import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rolldownOptions: {
      onwarn(warning, defaultHandler) {
        // React Query ships "use client" directives that have no meaning in this client-only bundle.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") {
          return;
        }
        defaultHandler(warning);
      }
    }
  }
});
