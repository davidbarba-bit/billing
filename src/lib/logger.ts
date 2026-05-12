import pino, { type Logger } from "pino";
import type { Config } from "../config.js";

export function buildLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    base: { service: "mini-lago" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.api_key",
        "*.password",
      ],
      remove: false,
    },
  });
}
