// dashboard.js - vanilla JS, no build step, matching Guard's own
// dashboard.js philosophy. Talks only to Compass's own API
// (/api/...) - never to Guard directly; Compass's guardDb.js is what
// reads Guard's data server-side.

const state = {
  apiKey: localStorage.getItem("compass_api_key") || "",
  savingsChart: null,
};

function apiKeyHeaders() {
  return state.apiKey ? { "X-API-Key": state.apiKey } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...apiKeyHeaders(), ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

function fmtUsd(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return `${Number(n).toFixed(1)}%`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function timeAgo(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const CONFIDENCE_BADGE = {
  "cost-only": "badge-muted",
  "insufficient-sample": "badge-muted",
  "shadow-tested-similar": "badge-good",
  "shadow-tested-diverges": "badge-danger",
  "human-reviewed": "badge-good",
};

// ---- Theme toggle -----------------------------------------------------
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("compass_theme", theme);
  document.getElementById("themeLight").classList.toggle("active", theme === "light");
  document.getElementById("themeDark").classList.toggle("active", theme === "dark");
}
document.getElementById("themeLight").onclick = () => setTheme("light");
document.getElementById("themeDark").onclick = () => setTheme("dark");
setTheme(localStorage.getItem("compass_theme") || "dark");

// ---- Access panel -------------------------------------------------------
document.getElementById("apiKeyInput").value = state.apiKey;
document.getElementById("saveKeyBtn").onclick = () => {
  state.apiKey = document.getElementById("apiKeyInput").value.trim();
  localStorage.setItem("compass_api_key", state.apiKey);
  document.getElementById("accessMsg").textContent = state.apiKey ? "Key saved for this browser." : "Cleared - requests will rely on Guard's bootstrap mode if it has no keys yet.";
  loadAll();
};

// ---- Health / Guard status ----------------------------------------------
async function loadHealth() {
  try {
    const h = await api("/api/health");
    document.getElementById("guardStatus").textContent = h.ok ? "● Guard connected" : "● Guard unreachable";
    document.getElementById("guardStatus").style.color = h.ok ? "var(--good)" : "var(--danger)";
  } catch {
    document.getElementById("guardStatus").textContent = "● Compass unreachable";
    document.getElementById("guardStatus").style.color = "var(--danger)";
  }
}

// ---- Summary cards --------------------------------------------------------
async function loadSummaryCards() {
  const [savings, cacheStats, semanticStats, recs] = await Promise.all([
    api("/api/savings/summary?days=30").catch(() => null),
    api("/api/cache/stats").catch(() => null),
    api("/api/semantic-cache/stats").catch(() => null),
    api("/api/recommendations").catch(() => []),
  ]);
  const liveRollouts = recs.filter((r) => r.rollout_pct > 0).length;

  const cards = [
    { label: "Net savings (30d)", value: savings ? fmtUsd(savings.total_net_savings_usd) : "—", live: true },
    { label: "Cache hit rate", value: cacheStats && cacheStats.total_hits + (semanticStats?.total_hits || 0) > 0 ? String(cacheStats.total_hits + (semanticStats?.total_hits || 0)) + " hits" : "0 hits" },
    { label: "Recommendations", value: String(recs.length) },
    { label: "Live rollouts", value: String(liveRollouts) },
  ];

  document.getElementById("summaryCards").innerHTML = cards
    .map(
      (c) => `<div class="card${c.live ? " live" : ""}"><div class="label">${esc(c.label)}</div><div class="value">${esc(c.value)}</div></div>`
    )
    .join("");
}

// ---- Tiered economics -----------------------------------------------------
async function loadTieredEconomics() {
  try {
    const report = await api("/api/savings/tiered-economics?days=30");
    const rows = report.scenarios
      .map((s) => {
        const diffClass = s.savings_vs_baseline_usd > 0 ? "color:var(--good);" : s.savings_vs_baseline_usd < 0 ? "color:var(--danger);" : "color:var(--text-muted);";
        return `<tr><td>${esc(s.label)}</td><td>${fmtUsd(s.monthly_cost_usd)}</td><td style="${diffClass}">${s.savings_vs_baseline_usd > 0 ? "+" : ""}${fmtUsd(s.savings_vs_baseline_usd)}</td><td>${s.quality_score ?? "—"}</td></tr>`;
      })
      .join("");
    document.querySelector("#tieredTable tbody").innerHTML = rows || `<tr><td colspan="4" style="color:var(--text-faint);">No spend in the last 30 days yet.</td></tr>`;
  } catch (err) {
    document.querySelector("#tieredTable tbody").innerHTML = `<tr><td colspan="4" style="color:var(--danger);">${esc(err.message)}</td></tr>`;
  }
}

// ---- Savings chart ----------------------------------------------------------
async function loadSavingsChart() {
  try {
    const summary = await api("/api/savings/summary?days=30");
    const labels = summary.by_kind.map((k) => k.kind.replace(/_/g, " "));
    const data = summary.by_kind.map((k) => k.net_savings_usd);
    const ctx = document.getElementById("savingsChart");
    if (state.savingsChart) state.savingsChart.destroy();
    const styles = getComputedStyle(document.documentElement);
    state.savingsChart = new Chart(ctx, {
      type: "bar",
      data: { labels: labels.length ? labels : ["no data yet"], datasets: [{ data: data.length ? data : [0], backgroundColor: styles.getPropertyValue("--money").trim() || "#f0b429" }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: styles.getPropertyValue("--text-muted").trim() } },
          y: { grid: { color: styles.getPropertyValue("--border").trim() }, ticks: { color: styles.getPropertyValue("--text-muted").trim() } },
        },
      },
    });
  } catch {
    /* chart is best-effort */
  }
}

// ---- Recommendations + approval workflow -------------------------------------
async function loadRecommendations() {
  const container = document.getElementById("recommendations");
  try {
    const recs = await api("/api/recommendations");
    if (!recs.length) {
      container.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">No recommendations yet - click "Regenerate from current spend" once Guard has usage history.</div>`;
      return;
    }
    container.innerHTML = recs.map(renderRecCard).join("");
    recs.forEach(wireRecCard);
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);">${esc(err.message)}</div>`;
  }
}

function renderRecCard(r) {
  const badgeClass = CONFIDENCE_BADGE[r.confidence] || "badge-muted";
  const statusBadge = { pending: "badge-signal", approved: "badge-good", rejected: "badge-danger", rolled_back: "badge-danger" }[r.status] || "badge-muted";
  return `
    <div class="rec-card" data-id="${r.id}">
      <div class="rec-title">
        <span>${esc(r.provider)}/${esc(r.current_model)} &rarr; ${esc(r.suggested_model)}</span>
        <span class="badge ${badgeClass}">${esc(r.confidence)}</span>
        <span class="badge ${statusBadge}">${esc(r.status)}</span>
        ${r.rollout_label ? `<span class="badge badge-signal">${esc(r.rollout_label)} (${r.rollout_pct}%)</span>` : ""}
      </div>
      <div class="rec-caveat">${esc(r.caveat || "")}</div>
      <div class="rec-stats">
        <div class="rec-stat"><div class="label" style="color:var(--text-muted);text-transform:uppercase;font-size:10px;">Current cost (30d)</div><div class="value" style="font-family:var(--font-data);">${fmtUsd(r.current_cost_usd)}</div></div>
        <div class="rec-stat"><div class="label" style="color:var(--text-muted);text-transform:uppercase;font-size:10px;">Est. savings</div><div class="value" style="font-family:var(--font-data);color:var(--good);">${fmtUsd(r.estimated_savings_usd)} (${fmtPct(r.estimated_savings_pct)})</div></div>
        <div class="rec-stat"><div class="label" style="color:var(--text-muted);text-transform:uppercase;font-size:10px;">Affected requests</div><div class="value" style="font-family:var(--font-data);">${r.affected_events ?? "—"}</div></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${r.rollout_pct}%;"></div></div>
      <div class="btn-row">
        <button class="primary approve-btn" ${r.status === "approved" ? "disabled" : ""}>Approve (1%)</button>
        <button class="secondary advance-btn" ${r.status !== "approved" ? "disabled" : ""}>Advance rollout &rarr;</button>
        <button class="danger reject-btn" ${r.status === "rejected" ? "disabled" : ""}>Reject</button>
        <button class="danger rollback-btn" ${r.rollout_pct === 0 ? "disabled" : ""}>Rollback</button>
      </div>
    </div>`;
}

function wireRecCard(r) {
  const card = document.querySelector(`.rec-card[data-id="${r.id}"]`);
  if (!card) return;
  card.querySelector(".approve-btn").onclick = async () => {
    try {
      await api(`/api/rollout/${r.id}/approve`, { method: "POST", body: JSON.stringify({ rollout_pct: 1 }) });
      loadRecommendations();
    } catch (err) {
      alert(err.message);
    }
  };
  card.querySelector(".advance-btn").onclick = async () => {
    const ladder = [0, 1, 5, 25, 50, 100];
    const next = ladder.find((p) => p > r.rollout_pct) || 100;
    try {
      await api(`/api/rollout/${r.id}/advance`, { method: "POST", body: JSON.stringify({ rollout_pct: next }) });
      loadRecommendations();
    } catch (err) {
      alert(err.message);
    }
  };
  card.querySelector(".reject-btn").onclick = async () => {
    try {
      await api(`/api/rollout/${r.id}/reject`, { method: "POST", body: JSON.stringify({}) });
      loadRecommendations();
    } catch (err) {
      alert(err.message);
    }
  };
  card.querySelector(".rollback-btn").onclick = async () => {
    try {
      await api(`/api/rollout/${r.id}/rollback`, { method: "POST", body: JSON.stringify({ note: "Manual rollback from dashboard" }) });
      loadRecommendations();
    } catch (err) {
      alert(err.message);
    }
  };
}

document.getElementById("generateRecsBtn").onclick = async () => {
  const label = document.getElementById("recGenerating");
  label.textContent = "generating…";
  try {
    await api("/api/recommendations/generate", { method: "POST", body: JSON.stringify({ days: 30 }) });
    await loadRecommendations();
    await loadSummaryCards();
    label.textContent = "";
  } catch (err) {
    label.textContent = `error: ${err.message}`;
  }
};
document.getElementById("autoCheckBtn").onclick = async () => {
  try {
    const result = await api("/api/rollout/auto-check", { method: "POST" });
    alert(result.rolled_back.length ? `Rolled back ${result.rolled_back.length} policy(ies) - see recommendations.` : "No rollouts needed rolling back.");
    loadRecommendations();
  } catch (err) {
    alert(err.message);
  }
};

// ---- Cache panels --------------------------------------------------------
async function loadCachePanels() {
  try {
    const stats = await api("/api/cache/stats");
    document.getElementById("cacheEntries").textContent = stats.current_size;
    document.getElementById("cacheHits").textContent = stats.total_hits;
  } catch {
    /* best-effort */
  }
  try {
    const stats = await api("/api/semantic-cache/stats");
    document.getElementById("semanticEntries").textContent = stats.current_size;
    document.getElementById("semanticMode").textContent = `${stats.mode} / ${stats.threshold}`;
  } catch {
    /* best-effort */
  }
}
document.getElementById("clearCacheBtn").onclick = async () => {
  if (!confirm("Clear the exact-match cache?")) return;
  await api("/api/cache/clear", { method: "POST" }).catch((e) => alert(e.message));
  loadCachePanels();
};
document.getElementById("clearSemanticBtn").onclick = async () => {
  if (!confirm("Clear the semantic cache?")) return;
  await api("/api/semantic-cache/clear", { method: "POST" }).catch((e) => alert(e.message));
  loadCachePanels();
};

// ---- Routing decisions --------------------------------------------------
async function loadRoutingTable() {
  try {
    const rows = await api("/api/router/decisions?limit=25");
    document.querySelector("#routingTable tbody").innerHTML =
      rows
        .map(
          (r) =>
            `<tr><td>${esc(r.requested_model)}</td><td>${esc(r.effective_model)}</td><td>${esc(r.classification)}</td><td>${r.cost_quality_dial ?? "—"}</td><td style="font-size:11px;color:var(--text-muted);">${esc((r.reasons || [])[0] || "")}</td></tr>`
        )
        .join("") || `<tr><td colspan="5" style="color:var(--text-faint);">No routing decisions logged yet - enable routing via X-Compass-Enable-Routing: true.</td></tr>`;
  } catch (err) {
    document.querySelector("#routingTable tbody").innerHTML = `<tr><td colspan="5" style="color:var(--danger);">${esc(err.message)}</td></tr>`;
  }
}

// ---- Evaluation results ----------------------------------------------------
async function loadEvaluationTable() {
  try {
    const rows = await api("/api/evaluation/results?limit=25");
    document.querySelector("#evalTable tbody").innerHTML =
      rows
        .map(
          (r) =>
            `<tr><td>${esc(r.provider)}/${esc(r.primary_model)}&rarr;${esc(r.candidate_model)}</td><td>${r.judge_score ?? "—"}</td><td>${r.lexical_similarity ?? "—"}</td><td>${r.deterministic_pass === null ? "—" : r.deterministic_pass ? "pass" : "fail"}</td><td>${esc(r.human_label || "—")}</td><td style="font-size:11px;">${timeAgo(r.created_at)}</td></tr>`
        )
        .join("") || `<tr><td colspan="6" style="color:var(--text-faint);">No evaluation results yet.</td></tr>`;
  } catch (err) {
    document.querySelector("#evalTable tbody").innerHTML = `<tr><td colspan="6" style="color:var(--danger);">${esc(err.message)}</td></tr>`;
  }
}

// ---- Audit log -----------------------------------------------------------
async function loadAuditLog() {
  const container = document.getElementById("auditLog");
  try {
    const rows = await api("/api/audit?limit=20");
    container.innerHTML =
      rows
        .map(
          (a) =>
            `<div style="padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px;"><span style="color:var(--text-muted);">${timeAgo(a.created_at)}</span> &middot; <b>${esc(a.actor)}</b> ${esc(a.action)} ${a.target ? `<code>${esc(a.target)}</code>` : ""}</div>`
        )
        .join("") || `<div style="color:var(--text-faint);font-size:13px;">No audit events yet.</div>`;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);">${esc(err.message)}</div>`;
  }
}

// ---- Orchestration ---------------------------------------------------------
async function loadAll() {
  await loadHealth();
  await Promise.all([loadSummaryCards(), loadTieredEconomics(), loadSavingsChart(), loadRecommendations(), loadCachePanels(), loadRoutingTable(), loadEvaluationTable(), loadAuditLog()]);
}

loadAll();
setInterval(loadAll, 30000);
