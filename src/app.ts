import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { DB } from "./db/client.js";
import { buildAuthMiddleware } from "./lib/auth.js";
import { errorMiddleware, notFound } from "./lib/errors.js";
import { buildCustomersRouter } from "./routes/customers.js";
import { buildTaxesRouter } from "./routes/taxes.js";

export function buildApp(db: DB, logger: Logger): Express {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/healthz" } }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", version: "0.1.0" });
  });

  const api = express.Router();
  api.use(buildAuthMiddleware(db));
  api.use(buildCustomersRouter(db));
  api.use(buildTaxesRouter(db));

  app.use("/api/v1", api);

  // 404 with Lago-shaped body for unknown api routes
  app.use((_req, _res, next) => {
    next(notFound("route"));
  });

  app.use(errorMiddleware);

  return app;
}
