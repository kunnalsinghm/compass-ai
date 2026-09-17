// index.js - Compass AI entrypoint.
//
// Run alongside a Guard deployment (see README for the two ways to point
// Compass at Guard's data: GUARD_DB_PATH for co-located SQLite, or
// GUARD_DB_DRIVER=postgres + GUARD_POSTGRES_URL for hosted Postgres).
// Compass's own data lives in its own database (server/storage) -
// nothing here ever writes to Guard's.

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");

const logger = require("./logger");
const guardDb = require("./guardDb");
const recommend = require("./recommend");
const rollout = require("./rollout");

const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.COMPASS_HOST || "0.0.0.0";

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: process.env.COMPASS_JSON_LIMIT || "5mb" }));

app.use("/api/health", require("./routes/health"));
app.use("/api/proxy", require("./routes/proxy"));
app.use("/api/cache", require("./routes/cache"));
app.use("/api/semantic-cache", require("./routes/semanticCache"));
app.use("/api/router", require("./routes/router"));
app.use("/api/evaluation", require("./routes/evaluation"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/recommendations", require("./routes/recommendations"));
app.use("/api/rollout", require("./routes/rollout"));
app.use("/api/savings", require("./routes/savings"));
app.use("/api/audit", require("./routes/audit"));

app.use(express.static(path.join(__dirname, "..", "public")));

app.use((err, req, res, next) => {
  logger.error("Unhandled error", { error: err.message, path: req.path });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal error" });
});

const REFRESH_MINUTES = Number(process.env.COMPASS_RECOMMENDATION_REFRESH_MINUTES) || 60;
const AUTOCHECK_MINUTES = Number(process.env.COMPASS_AUTO_ROLLBACK_CHECK_MINUTES) || 15;

async function start() {
  try {
    await guardDb.ready;
    logger.info(`Connected to Guard's database (dialect: ${guardDb.dialect})`);
  } catch (err) {
    logger.error("Could not connect to Guard's database on startup - Compass will keep retrying on each request", { error: err.message });
  }

  app.listen(PORT, HOST, () => {
    logger.info(`Compass AI running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`Proxy endpoint: http://localhost:${PORT}/api/proxy/:provider (point your SDK's baseURL here)`);
  });

  if (REFRESH_MINUTES > 0) {
    setInterval(() => {
      recommend.generateRecommendations({ days: 30 }).catch((err) => logger.error("Scheduled recommendation refresh failed", { error: err.message }));
    }, REFRESH_MINUTES * 60 * 1000).unref();
  }
  if (AUTOCHECK_MINUTES > 0) {
    setInterval(() => {
      rollout.checkAutoRollbackConditions().catch((err) => logger.error("Scheduled auto-rollback check failed", { error: err.message }));
    }, AUTOCHECK_MINUTES * 60 * 1000).unref();
  }
}

start();

module.exports = app;
