// identity.js - decides which TEAM a proxy request acts as, mirroring
// Guard's keyIdentity.js rule so Compass can never be used to sidestep it.
//
// Why this matters more in Compass than in Guard: Compass answers some
// requests from its own cache WITHOUT ever reaching Guard. Cache entries
// are scoped by team, so if the team were simply whatever the caller put
// in X-Team, any key could read another team's cached responses by
// claiming that team's name - and Guard's own team check would never run
// because the request never gets forwarded. Resolving identity here,
// before the cache lookup, closes that hole.
//
//   Key bound to a team   -> that team is authoritative. A different X-Team
//                            header is a 403 (not a silent override), same
//                            as Guard.
//   Key not bound         -> X-Team is a self-declared label (legacy Guard
//                            behaviour). COMPASS_STRICT_IDENTITY=true (or
//                            Guard's FINOPS_STRICT_IDENTITY=true) refuses
//                            such keys, which is what you want wherever the
//                            cache must be a real isolation boundary.
//   Bootstrap mode        -> unchanged: everything is open until Guard has
//                            its first key.

const BOOTSTRAP_KEY_ID = "bootstrap";

function strict(env = process.env) {
  return env.COMPASS_STRICT_IDENTITY === "true" || env.FINOPS_STRICT_IDENTITY === "true";
}

function resolveTeam(apiKey, teamHeader, env = process.env) {
  const header = teamHeader ? String(teamHeader) : null;
  const bound = apiKey?.team || null;
  const isBootstrap = apiKey?.key_id === BOOTSTRAP_KEY_ID;

  if (bound) {
    if (header && header !== bound) {
      return {
        ok: false,
        status: 403,
        error: `This API key is bound to team '${bound}' but the request claimed team '${header}'. Omit X-Team or send the bound team.`,
      };
    }
    return { ok: true, team: bound, source: "key" };
  }

  if (strict(env) && !isBootstrap) {
    return {
      ok: false,
      status: 403,
      error: "This API key is not bound to a team and strict identity is on (COMPASS_STRICT_IDENTITY / FINOPS_STRICT_IDENTITY). Bind the key to a team in Guard.",
    };
  }

  return { ok: true, team: header, source: header ? "header" : "none" };
}

// The key id to use for Guard's key-scoped policy lookups: bootstrap mode and
// dashboard-session pseudo-keys are not real API keys (same rule as Guard's
// keyIdentity.realKeyId).
function realKeyId(apiKey) {
  const id = apiKey?.key_id;
  if (!id || id === BOOTSTRAP_KEY_ID || String(id).startsWith("user:")) return null;
  return id;
}

module.exports = { resolveTeam, realKeyId };
