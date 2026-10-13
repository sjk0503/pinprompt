import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  fullyParallel: true,
  reporter: "list",
  webServer: {
    command: "python3 -m http.server 4310 --bind 127.0.0.1",
    cwd: root,
    url: "http://127.0.0.1:4310/demo/index.html",
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://127.0.0.1:4310/demo/",
    headless: true,
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
