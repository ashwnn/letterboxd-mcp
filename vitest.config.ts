import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLIC_URL: "https://letterboxd-mcp.test.workers.dev",
          TIMEZONE: "America/Vancouver",
          READ_ONLY: "false",
          ALLOWED_REDIRECT_HOSTS: "claude.ai,claude.com,chatgpt.com",
          ENVIRONMENT: "test",
          ADMIN_PASSWORD: "correct-horse-battery-staple",
          LETTERBOXD_CLIENT_ID: "test-client-id",
          LETTERBOXD_CLIENT_SECRET: "test-client-secret",
          COOKIE_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
