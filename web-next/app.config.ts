import { defineConfig } from "@solidjs/start/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  vite: () => ({
    server: {
      fs: {
        // For serving Pretendard Variable dynamic subsets
        // Deno installs the dependencies at the root of the workspace,
        // so the subset files are located inside the root node_modules.
        allow: ["../node_modules"],
      },
    },
    plugins: [tailwindcss()],
  }),
});
