import { checkLayout } from "./layout-checks.mjs";

const metadata = JSON.parse(document.querySelector("#workbench-render").textContent);
const send = (type, extra = {}) => parent.postMessage({
  channel: "agenda-workbench", type, id: metadata.id, revision: metadata.revision, side: metadata.side, ...extra
}, metadata.origin);
let ready = false;
let failed = false;
let waiting = false;
let visible = false;

function requiredFonts() {
  // Failed probe/glyph-fallback faces are normal; require the effective font and weight to have a loaded face.
  const requests = new Map();
  for (const node of document.querySelectorAll(".agenda .title, .agenda .label, .agenda .description, .agenda-source")) {
    if (!node.textContent.trim() || !node.getClientRects().length || node.closest("[hidden]")) continue;
    const style = getComputedStyle(node);
    const descriptor = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    requests.set(descriptor, style);
  }
  if (document.fonts.status !== "loaded") return false;
  const family = value => value.trim().replace(/^["']|["']$/g, "");
  for (const [descriptor, style] of requests) {
    const loaded = [...document.fonts].some(face => {
      if (face.status !== "loaded" || family(face.family) !== family(style.fontFamily.split(",")[0])
        || face.style !== style.fontStyle) return false;
      const weights = face.weight === "normal" ? [400] : face.weight === "bold" ? [700] : face.weight.split(/\s+/).map(Number);
      const weight = Number(style.fontWeight);
      return weight >= weights[0] && weight <= weights.at(-1);
    });
    if (!loaded)
      throw new Error(`Required native font is unavailable: ${descriptor}. Run scripts\\setup-display.ps1.`);
  }
  return true;
}

function failure(message) {
  if (failed) return;
  failed = true;
  ready = false;
  send("failed", { error: message });
}

async function waitUntilReady() {
  if (waiting || failed) return;
  waiting = true;
  let remaining = 10_000;
  let previous = performance.now();
  while (!failed) {
    const now = performance.now();
    if (visible) remaining -= now - previous;
    previous = now;
    if (window.workbenchFailures.length) {
      failure(window.workbenchFailures.join("\n"));
      break;
    }
    const agenda = document.querySelector(".agenda");
    const framework = document.querySelector('link[href="/css/3.4.3/plugins.css"]');
    if (visible && agenda && framework?.sheet && document.fonts.status === "loaded"
      && window.TRMNL_PLUGINS_READY === true && agenda.dataset.agendaReady === "true") {
      let fontsLoaded;
      try {
        fontsLoaded = requiredFonts();
      } catch (error) {
        failure(error.message);
        break;
      }
      if (fontsLoaded && document.fonts.status === "loaded" && agenda.isConnected && agenda.dataset.agendaReady === "true"
        && window.TRMNL_PLUGINS_READY === true && window.workbenchFailures.length === 0) {
        ready = true;
        send("ready", { inputHash: metadata.inputHash });
        break;
      }
    }
    if (remaining <= 0) {
      failure(`${metadata.side === "baseline" ? "Baseline may be incompatible. " : ""}Preview readiness timed out: require framework 3.4.3, loaded fonts, TRMNL_PLUGINS_READY, and production data-agenda-ready.`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, visible ? 20 : 200));
  }
  waiting = false;
}

window.addEventListener("error", () => {
  if (window.workbenchFailures.length) failure(window.workbenchFailures.join("\n"));
}, true);
window.addEventListener("unhandledrejection", () => failure("A preview script rejected a promise."));
document.fonts.addEventListener("loadingerror", () => {
  if (ready) {
    ready = false;
    send("loading");
  }
  void waitUntilReady();
});

const agenda = document.querySelector(".agenda");
if (agenda) new MutationObserver(() => {
  if (ready && agenda.dataset.agendaReady !== "true") {
    ready = false;
    send("loading");
    void waitUntilReady();
  }
}).observe(agenda, { attributes: true, attributeFilter: ["data-agenda-ready"] });

window.addEventListener("message", event => {
  const message = event.data;
  if (event.source !== parent || event.origin !== metadata.origin || message?.channel !== "agenda-workbench"
    || message.id !== metadata.id || message.revision !== metadata.revision
    || message.side !== metadata.side) return;
  if (message.type === "visibility") {
    visible = message.visible === true;
    return;
  }
  if (message.type !== "check") return;
  if (!ready || failed) {
    send("checks", { checkId: message.checkId, findings: [{ rule: "readiness", passed: false, message: "The current render is not ready." }] });
    return;
  }
  send("checks", {
    checkId: message.checkId, findings: checkLayout(document, metadata.agenda, metadata.target)
  });
});

send("bridge");
void waitUntilReady();
