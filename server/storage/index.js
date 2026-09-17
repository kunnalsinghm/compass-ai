// storage/index.js - picks Compass's own storage backend (its cache,
// routing, evaluation, recommendation, and savings tables). This is
// SEPARATE from server/guardDb.js, which opens Guard's database READ-ONLY
// for historical usage/pricing/RBAC data. Every module in this codebase
// that needs Compass's own tables should require THIS file; every module
// that needs Guard's data should require ../guardDb instead. The two are
// never the same connection.

const driver = process.env.COMPASS_DB_DRIVER === "postgres" ? "postgres" : "sqlite";

module.exports = require(`./${driver}`);
