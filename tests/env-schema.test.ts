import { describe, expect, it } from "vitest";
import { loadEnv } from "../packages/core/src/index.js";

describe("envSchema optional URL inputs", () => {
  it("accepts bare host values for webhook-related optional variables", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: "token",
      PULSARBOT_ACCESS_TOKEN: "access",
      PUBLIC_BASE_URL: "pulsarbotserver-production.up.railway.app",
      RAILWAY_STATIC_URL: "pulsarbotserver-production.up.railway.app",
      TELEGRAM_WEBHOOK_URL: "pulsarbotserver-production.up.railway.app",
    });

    expect(env.PUBLIC_BASE_URL).toBe("pulsarbotserver-production.up.railway.app");
    expect(env.RAILWAY_STATIC_URL).toBe("pulsarbotserver-production.up.railway.app");
    expect(env.TELEGRAM_WEBHOOK_URL).toBe("pulsarbotserver-production.up.railway.app");
  });

  it("accepts empty optional URL variables without failing startup", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: "token",
      PULSARBOT_ACCESS_TOKEN: "access",
      PUBLIC_BASE_URL: "",
      RAILWAY_STATIC_URL: "",
      TELEGRAM_WEBHOOK_URL: "",
    });

    expect(env.PUBLIC_BASE_URL).toBe("");
    expect(env.RAILWAY_STATIC_URL).toBe("");
    expect(env.TELEGRAM_WEBHOOK_URL).toBe("");
  });
});
