import { defineConfig } from "@playwright/test";

// The e2e run always exercises the access-token gate, even locally.
const E2E_ACCESS_TOKEN = process.env.EASYMODE_ACCESS_TOKEN || "easymode-e2e-access-token";
process.env.EASYMODE_ACCESS_TOKEN = E2E_ACCESS_TOKEN;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
    env: { EASYMODE_ACCESS_TOKEN: E2E_ACCESS_TOKEN },
  },
});
