import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.headers['x-api-key']",
    "req.headers['x-vapi-secret']",
    "req.body",
    "apiKey",
    "token",
    "webhookSecret",
    "redisUrl",
    "config.apiKey",
    "config.token",
    "config.webhookSecret",
    "config.redisUrl",
    "config._credentials",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
