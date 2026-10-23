const controls = Object.fromEntries(["scenario", "target", "zoom", "overview", "check", "baseline-commit",
  "description", "reference", "status", "comparisons", "checks"].map(id => [id, document.getElementById(id)]));
let scenarioId = "normal-mixed";
let targetId = "og-full";
let overview = false;
let state;
let serial = 0;
let controller;
let disconnected = false;
let checkId;
let checkTimer;
const pairs = new Map();
const timers = new Set();
const observers = new Set();
const checkResults = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function status(value, message) {
  document.body.dataset.state = value;
  controls.status.textContent = message;
  controls.check.disabled = value !== "ready";
}

function invalidateChecks() {
  clearTimeout(checkTimer);
  checkId = null;
  checkResults.clear();
  controls.checks.dataset.state = "unchecked";
  controls.checks.replaceChildren(document.createTextNode("Checks have not run for this comparison."));
}

function updateStatus() {
  const failed = [...pairs.values()].find(pair => pair.error);
  if (failed) {
    status("failed", failed.error);
  } else if (pairs.size && [...pairs.values()].every(pair => pair.ready)) {
    status("ready", `${overview ? "All four comparisons" : "Selected comparison"} ready. Framework, fonts, and production fitting complete.`);
  } else {
    const completed = [...pairs.values()].filter(pair => pair.ready).length;
    status("loading", overview
      ? `Loading comparisons (${completed}/4 ready). Scroll through the overview to fit offscreen previews.`
      : "Loading the current comparison. Waiting for framework, fonts, and production fitting...");
  }
}

function clearFrameTimer(entry) {
  if (!entry.timer) return;
  clearTimeout(entry.timer);
  timers.delete(entry.timer);
  entry.timer = null;
  entry.remaining -= performance.now() - entry.started;
}

function updateVisibility(pair, side) {
  const entry = pair.frames[side];
  if (!entry || pairs.get(pair.target.id) !== pair || pair.error) return;
  clearFrameTimer(entry);
  entry.visible = entry.intersecting && !document.hidden;
  entry.iframe.contentWindow?.postMessage({
    channel: "agenda-workbench", type: "visibility", id: pair.metadata.id,
    revision: pair.metadata.revision, side, visible: entry.visible
  }, "*");
  if (entry.iframe.dataset.state === "ready") return;
  entry.label.textContent = entry.visible ? "Loading native preview..." : "Waiting for visible preview...";
  if (entry.visible) {
    entry.started = performance.now();
    entry.timer = setTimeout(() => fail(pair,
      "Preview readiness bridge did not complete. Check scripts, framework assets, and fonts.", side), Math.max(0, entry.remaining));
    timers.add(entry.timer);
  }
}

function scalePreviews() {
  for (const pair of pairs.values()) {
    if (!pair.metadata) continue;
    for (const entry of Object.values(pair.frames)) {
      const { width, height } = pair.metadata.target;
      const availableHeight = Math.max(160, window.innerHeight - document.querySelector("header").offsetHeight - 100);
      const scale = controls.zoom.value === "100" ? 1 : Math.min(1, entry.viewport.clientWidth / width, availableHeight / height);
      entry.space.style.width = `${width * scale}px`;
      entry.space.style.height = `${height * scale}px`;
      entry.iframe.style.transform = `scale(${scale})`;
    }
  }
}

function fail(pair, message, side) {
  if (pair.error) return;
  pair.ready = false;
  pair.error = `${pair.target.name}${side ? ` / ${side === "baseline" ? "Baseline" : "Working copy"}` : ""}: ${message}`;
  pair.node.dataset.state = "failed";
  Object.values(pair.frames).forEach(clearFrameTimer);
  if (side && pair.frames[side]) {
    const entry = pair.frames[side];
    entry.card.dataset.state = "failed";
    entry.label.textContent = "Failed";
    entry.viewport.replaceChildren(element("p", "render-error", message));
  } else {
    pair.content.replaceChildren(element("p", "render-error", message));
  }
  invalidateChecks();
  updateStatus();
}

function createPair(target) {
  const node = element("section", "comparison");
  node.dataset.target = target.id;
  node.dataset.state = "loading";
  node.append(element("h2", "", `${target.name} - native ${target.width} x ${target.height}`));
  const content = element("div", "pair");
  content.append(element("p", "", "Rendering the current inputs..."));
  node.append(content);
  controls.comparisons.append(node);
  const pair = { node, content, target, metadata: null, frames: {}, ready: false, error: null };
  pairs.set(target.id, pair);
  return pair;
}

async function readJson(url, signal) {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `Workbench HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function options(select, values, selected) {
  const nodes = values.map(item => {
    const option = element("option", "", item.name);
    option.value = item.id;
    return option;
  });
  if (!values.some(item => item.id === selected)) {
    const missing = element("option", "", `${selected} (missing)`);
    missing.value = selected;
    nodes.push(missing);
  }
  select.replaceChildren(...nodes);
  select.value = selected;
}

async function loadPair(pair, batch, signal) {
  try {
    const query = new URLSearchParams({ scenario: scenarioId, target: pair.target.id, overview: String(overview) });
    const metadata = await readJson(`/api/comparison?${query}`, signal);
    if (batch !== serial) return;
    if (metadata.revision !== state.revision) { void refresh(); return; }
    pair.metadata = metadata;
    pair.node.dataset.comparisonId = metadata.id;
    pair.node.dataset.revision = metadata.revision;
    pair.node.dataset.inputHash = metadata.inputHash;
    pair.node.dataset.candidateHash = metadata.candidateHash;
    controls.reference.textContent = `Reference: ${metadata.agenda.generated_at} | Source state: ${metadata.agenda.state} | Source success: ${metadata.agenda.source_succeeded_at ?? "unavailable"}`;
    pair.content.replaceChildren();
    for (const side of ["baseline", "candidate"]) {
      const card = element("article", "preview-card");
      card.dataset.side = side;
      card.dataset.state = "loading";
      card.append(element("h3", "", side === "baseline" ? "Baseline (committed UI)" : "Working copy"));
      const label = element("p", "preview-status", "Loading native preview...");
      const viewport = element("div", "viewport");
      const space = element("div", "scale-space");
      const iframe = element("iframe");
      iframe.title = `${pair.target.name} ${side === "baseline" ? "baseline" : "working copy"}`;
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.width = metadata.target.width;
      iframe.height = metadata.target.height;
      iframe.style.width = `${metadata.target.width}px`;
      iframe.style.height = `${metadata.target.height}px`;
      iframe.dataset.side = side;
      iframe.dataset.state = "loading";
      iframe.dataset.inputHash = metadata.inputHash;
      space.append(iframe);
      viewport.append(space);
      card.append(label, viewport);
      pair.content.append(card);
      pair.frames[side] = {
        card, label, viewport, space, iframe, timer: null, remaining: 12_000,
        started: 0, visible: false, intersecting: false
      };
      const observer = new IntersectionObserver(([observation]) => {
        if (batch !== serial) return;
        pair.frames[side].intersecting = observation.isIntersecting;
        updateVisibility(pair, side);
      });
      observers.add(observer);
      observer.observe(viewport);
      iframe.src = metadata.previews[side];
    }
    scalePreviews();
  } catch (error) {
    if (batch !== serial || error.name === "AbortError") return;
    if (error.status === 409) {
      setTimeout(() => { if (batch === serial) void refresh(); }, 80);
    } else {
      fail(pair, error.message);
    }
  }
}

async function refresh() {
  const batch = ++serial;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  timers.forEach(clearTimeout);
  timers.clear();
  observers.forEach(observer => observer.disconnect());
  observers.clear();
  pairs.clear();
  controls.comparisons.replaceChildren();
  controls.reference.textContent = "";
  invalidateChecks();
  status("loading", "Reading the latest saved inputs...");
  try {
    const current = await readJson("/api/state", signal);
    if (batch !== serial) return;
    state = current;
    document.body.dataset.revision = state.revision;
    controls["baseline-commit"].textContent = state.baselineCommit;
    options(controls.scenario, state.scenarios, scenarioId);
    options(controls.target, state.targets, targetId);
    controls.description.textContent = state.scenarios.find(item => item.id === scenarioId)?.description ?? "";
    if (state.error) throw new Error(state.error);
    if (disconnected) throw new Error("Live updates disconnected. Reconnecting...");
    const selected = overview ? state.targets : state.targets.filter(target => target.id === targetId);
    if (!selected.length) throw new Error("The selected target is unavailable. Select one of the four supported targets.");
    controls.comparisons.classList.toggle("overview", overview);
    await Promise.all(selected.map(target => loadPair(createPair(target), batch, signal)));
    if (batch === serial) updateStatus();
  } catch (error) {
    if (batch === serial && error.name !== "AbortError") status("failed", error.message);
  }
}

function showChecks() {
  const expected = pairs.size * 2;
  const failures = [...checkResults.values()].flatMap(result => result.findings.filter(finding => !finding.passed));
  const complete = checkResults.size === expected;
  controls.checks.dataset.state = complete ? failures.length ? "failed" : "passed" : "running";
  controls.checks.replaceChildren(element("h2", "", complete
    ? failures.length ? `${failures.length} layout checks failed.` : "All displayed layout checks passed."
    : `Checking current renders (${checkResults.size}/${expected})...`));
  for (const result of checkResults.values()) {
    const failed = result.findings.filter(finding => !finding.passed);
    controls.checks.append(element("h3", "", `${result.name}: ${failed.length ? `${failed.length} failed` : `${result.findings.length} passed`}`));
    if (failed.length) {
      const list = element("ul");
      failed.forEach(finding => list.append(element("li", "", `${finding.rule}: ${finding.message}`)));
      controls.checks.append(list);
    }
  }
  if (complete) clearTimeout(checkTimer);
}

window.addEventListener("message", event => {
  const message = event.data;
  if (message?.channel !== "agenda-workbench") return;
  for (const pair of pairs.values()) {
    if (!pair.metadata || message.id !== pair.metadata.id || message.revision !== pair.metadata.revision) continue;
    const entry = pair.frames[message.side];
    if (!entry || event.source !== entry.iframe.contentWindow) continue;
    if (message.type === "bridge") {
      updateVisibility(pair, message.side);
    } else if (message.type === "failed") {
      fail(pair, message.error, message.side);
    } else if (message.type === "ready" && !pair.error && message.inputHash === pair.metadata.inputHash) {
      clearFrameTimer(entry);
      entry.iframe.dataset.state = "ready";
      entry.card.dataset.state = "ready";
      entry.label.textContent = "Ready";
      pair.ready = Object.values(pair.frames).length === 2
        && Object.values(pair.frames).every(frame => frame.iframe.dataset.state === "ready");
      pair.node.dataset.state = pair.ready ? "ready" : "loading";
      updateStatus();
    } else if (message.type === "loading" && !pair.error) {
      entry.iframe.dataset.state = "loading";
      entry.card.dataset.state = "loading";
      entry.label.textContent = "Fitting...";
      pair.ready = false;
      pair.node.dataset.state = "loading";
      entry.remaining = 12_000;
      updateVisibility(pair, message.side);
      invalidateChecks();
      updateStatus();
    } else if (message.type === "checks" && checkId && message.checkId === checkId && pair.ready) {
      checkResults.set(`${pair.target.id}/${message.side}`, {
        name: `${pair.target.name} / ${message.side === "baseline" ? "Baseline" : "Working copy"}`, findings: message.findings
      });
      showChecks();
    }
    return;
  }
});

controls.scenario.addEventListener("change", () => { scenarioId = controls.scenario.value; void refresh(); });
controls.target.addEventListener("change", () => { targetId = controls.target.value; void refresh(); });
controls.zoom.addEventListener("change", scalePreviews);
controls.overview.addEventListener("click", () => {
  overview = !overview;
  controls.overview.setAttribute("aria-pressed", String(overview));
  void refresh();
});
controls.check.addEventListener("click", () => {
  if (document.body.dataset.state !== "ready") return;
  invalidateChecks();
  checkId = crypto.randomUUID();
  controls.checks.dataset.state = "running";
  showChecks();
  checkTimer = setTimeout(() => {
    controls.checks.dataset.state = "failed";
    controls.checks.replaceChildren(element("p", "render-error", "Layout checks timed out. The current results are incomplete."));
    checkId = null;
  }, 10_000);
  for (const pair of pairs.values()) for (const [side, frame] of Object.entries(pair.frames))
    frame.iframe.contentWindow.postMessage({
      channel: "agenda-workbench", type: "check", id: pair.metadata.id, revision: pair.metadata.revision, side, checkId
    }, "*");
});
window.addEventListener("resize", scalePreviews);
document.addEventListener("visibilitychange", () => {
  for (const pair of pairs.values()) for (const side of Object.keys(pair.frames)) updateVisibility(pair, side);
});

await refresh();
const updates = new EventSource("/events");
updates.onmessage = event => {
  const update = JSON.parse(event.data);
  if (update.revision !== state?.revision) void refresh();
};
updates.onerror = () => {
  disconnected = true;
  ++serial;
  controller?.abort();
  timers.forEach(clearTimeout);
  observers.forEach(observer => observer.disconnect());
  observers.clear();
  pairs.clear();
  controls.comparisons.replaceChildren();
  controls.reference.textContent = "";
  invalidateChecks();
  status("failed", "Live updates disconnected. Reconnecting; older output is not current.");
};
updates.onopen = () => {
  if (disconnected) {
    disconnected = false;
    void refresh();
  }
};
