import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: 0,
  /* Reporter to use */
  reporter: "list",
  /* Shared settings for all the projects below. */
  use: {
    /* Keep useful diagnostics even though this gate deliberately has no retries. */
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    headless: true,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
