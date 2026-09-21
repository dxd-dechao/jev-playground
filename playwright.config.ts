import { defineConfig, devices } from "@playwright/test";

/**
 * Two projects, one per viewport the acceptance criteria name: desktop at
 * ~1440px and mobile at ~390px. Screenshots are written to `screenshots/`,
 * which is git-ignored test evidence.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-390",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "npm run start -- --port 3100 --hostname 127.0.0.1",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    /**
     * Provider isolation for browser tests.
     *
     * Live behaviour is exercised against mocked `/api/config` and
     * `/api/evaluate` responses, so the server under test must not be able to
     * reach TypeSafe at all. Emptying these variables means that even on a
     * machine with a real key configured, an unmocked request can only produce a
     * 503 — never a billed call. `reuseExistingServer` is deliberately not
     * relied on for this: if a server is already running, it was started by this
     * same command.
     */
    env: {
      TYPESAFE_API_KEY: "",
      TYPESAFE_BASE_URL: "",
      TYPESAFE_MODEL: "",
      TYPESAFE_DEFAULT_MODEL: "",
    },
  },
});
