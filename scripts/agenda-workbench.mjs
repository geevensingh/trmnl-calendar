import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { AgendaContractError, agendaSchemaVersion, validateAgenda } from "./agenda-contract.mjs";
import { isolatedGitEnvironment } from "./git-environment.mjs";

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const frameworkVersion = "3.4.3";
const templateNames = ["shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"];
const targets = [
  { id: "og-full", name: "OG Full", device: "og", placement: "full", width: 800, height: 480 },
  { id: "v2-full", name: "X / v2 Full", device: "v2", placement: "full", width: 1872, height: 1404 },
  { id: "v2-half_horizontal", name: "X / v2 Half-horizontal", device: "v2", placement: "half_horizontal", width: 1872, height: 1404 },
  { id: "v2-half_vertical", name: "X / v2 Half-vertical", device: "v2", placement: "half_vertical", width: 1872, height: 1404 }
];

class WorkbenchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function superseded() {
  return new WorkbenchError("Render superseded by a newer saved input. Waiting for the current revision.", 409);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function trimCache(cache, maximum) {
  while (cache.size > maximum) cache.delete(cache.keys().next().value);
}

function jsonForHtml(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function git(workspace, ...arguments_) {
  try {
    const { stdout } = await execute("git", arguments_, {
      cwd: workspace, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      env: isolatedGitEnvironment({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" })
    });
    return stdout;
  } catch {
    throw new WorkbenchError("Git could not read the requested local baseline. Use an available compatible commit in this workspace.");
  }
}

async function baselineInputs(workspace, revision) {
  const commit = (await git(workspace, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`)).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    throw new WorkbenchError("Git did not resolve the baseline to a full immutable commit.");
  const [contract, renderer, ...templates] = await Promise.all([
    git(workspace, "show", `${commit}:docs/agenda-contract.md`),
    git(workspace, "show", `${commit}:display/render.rb`),
    ...templateNames.map(name => git(workspace, "show", `${commit}:display/src/${name}`))
  ]);
  const schemas = [...contract.matchAll(/^# Agenda HTTP and display contract, version (\d+)\s*$/gm)];
  const pins = [...renderer.matchAll(/\/(css|js)\/(\d+\.\d+\.\d+)\/plugins\.(?:css|js)/g)];
  if (schemas.length !== 1 || Number(schemas[0][1]) !== agendaSchemaVersion
    || !["css", "js"].every(kind => pins.some(pin => pin[1] === kind))
    || pins.some(pin => pin[2] !== frameworkVersion))
    throw new WorkbenchError(`Incompatible baseline ${commit}: require agenda schema ${agendaSchemaVersion} and explicit TRMNL CSS/JavaScript ${frameworkVersion} pins.`);
  return { commit, templates };
}

async function loadCatalogue(directory) {
  const entries = new Map();
  const names = (await readdir(directory)).filter(name => /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(name)).sort();
  for (const name of names) {
    const id = name.slice(0, -5);
    let fileHash;
    try {
      const bytes = await readFile(join(directory, name));
      fileHash = hash(bytes);
      if (bytes.length > 128 * 1024) throw new WorkbenchError("Scenario exceeds 128 KiB.");
      let scenario;
      try {
        scenario = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError)
          throw new WorkbenchError("Invalid UTF-8 or JSON. Repair the scenario file.");
        throw error;
      }
      if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)
        || Object.keys(scenario).sort().join(",") !== "agenda,description,id,name"
        || scenario.id !== id || typeof scenario.name !== "string" || !scenario.name.trim()
        || typeof scenario.description !== "string")
        throw new WorkbenchError("Supply exactly id (matching the filename), name, description, and agenda.");
      validateAgenda(scenario.agenda);
      for (const day of ["primary", "secondary"]) {
        const ids = scenario.agenda[day].occurrences.map(occurrence => occurrence.id);
        if (new Set(ids).size !== ids.length)
          throw new WorkbenchError(`agenda.${day}.occurrences: identifiers must be unique within each day.`);
      }
      const payload = JSON.stringify(scenario.agenda);
      entries.set(id, { ...scenario, payload, inputHash: hash(payload), fileHash });
    } catch (error) {
      if (!(error instanceof WorkbenchError || error instanceof AgendaContractError)
        && !["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
      entries.set(id, {
        id, name: `${id} (invalid)`, description: "", fileHash: fileHash ?? error.code,
        error: `${name}: ${error instanceof AgendaContractError || error instanceof WorkbenchError
          ? error.message : "The scenario file could not be read."}`
      });
    }
  }
  if (!entries.size) throw new WorkbenchError("No named JSON scenarios found in display\\scenarios.");
  return entries;
}

async function installedAssets() {
  const directory = join(toolRoot, ".tools", "framework");
  for (const path of [join("css", frameworkVersion, "plugins.css"), join("js", frameworkVersion, "plugins.js")]) {
    try {
      await access(join(directory, path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new WorkbenchError(`Missing framework asset ${path}. Run scripts\\setup-display.ps1.`);
    }
  }
  let fonts;
  try {
    fonts = await readdir(join(directory, "fonts"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new WorkbenchError("Missing framework fonts. Run scripts\\setup-display.ps1.");
  }
  if (!fonts.some(name => /\.(woff2?|ttf)$/.test(name)))
    throw new WorkbenchError("Missing framework fonts. Run scripts\\setup-display.ps1.");
  return directory;
}

async function rubyExecutable() {
  if (process.env.TRMNL_RUBY) return process.env.TRMNL_RUBY;
  const local = join(toolRoot, ".tools", "ruby", "bin", "ruby.exe");
  try {
    await access(local);
    return local;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "ruby";
  }
}

async function main() {
  const { values } = parseArgs({
    options: { baseline: { type: "string", default: "HEAD" }, port: { type: "string", default: "8898" },
      workspace: { type: "string", default: toolRoot }, help: { type: "boolean", default: false } }
  });
  if (values.help) {
    console.log("node scripts\\agenda-workbench.mjs [--baseline <local-revision>] [--port <0|1024..65535>] [--workspace <local-directory>]");
    return;
  }
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535)))
    throw new WorkbenchError("Supply port 0 (automatically allocated) or a port from 1024 to 65535.");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new WorkbenchError("Install Node.js 22 or newer.");

  const workspace = resolve(values.workspace);
  const scenarioDirectory = join(workspace, "display", "scenarios");
  const templateDirectory = join(workspace, "display", "src");
  const baseline = await baselineInputs(workspace, values.baseline);
  const assets = await installedAssets();
  const ruby = await rubyExecutable();
  try {
    const { stdout } = await execute(ruby, ["-rbundler/setup", "-rtrmnl/liquid", "-e", "print RUBY_VERSION"], {
      cwd: toolRoot, timeout: 30_000, maxBuffer: 64 * 1024
    });
    if (!stdout.startsWith("4.")) throw new WorkbenchError("Ruby 4 is required.");
  } catch {
    throw new WorkbenchError("Ruby 4 and locked trmnl-liquid gems are unavailable. Select TRMNL_RUBY if needed and run scripts\\setup-display.ps1.");
  }

  let catalogue = await loadCatalogue(scenarioDirectory);
  const catalogueIdentity = entries => hash([...entries].map(([id, item]) => `${id}:${item.fileHash}`).join("\n"));
  async function templateIdentity() {
    const identities = await Promise.all(templateNames.map(async name => {
      try {
        return `${name}:${hash(await readFile(join(templateDirectory, name)))}`;
      } catch (error) {
        if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
        return `${name}:${error.code}`;
      }
    }));
    return hash(identities.join("\n"));
  }
  let knownCatalogue = catalogueIdentity(catalogue);
  let knownTemplates = await templateIdentity();
  let changeSerial = 0;
  let revision = 1;
  let watchError = null;
  let watcherFailed = false;
  let closing = false;
  let catalogueUpdate = Promise.resolve();
  let debounce;
  let active = 0;
  const queue = [];
  const children = new Set();
  const watchers = [];
  const subscribers = new Set();
  const markupCache = new Map();
  const documents = new Map();
  const inFlight = new Set();
  const artifactDirectory = join(toolRoot, "artifacts", "agenda-workbench");
  await mkdir(artifactDirectory, { recursive: true });
  const runDirectory = await mkdtemp(join(artifactDirectory, "run-"));
  const baselineDirectory = join(runDirectory, "baseline");
  let server;
  let heartbeat;

  async function stop(exitCode = 0) {
    if (closing) return;
    closing = true;
    clearTimeout(debounce);
    clearInterval(heartbeat);
    watchers.forEach(watcher => watcher.close());
    subscribers.forEach(response => response.end());
    for (const pending of queue.splice(0)) pending.reject(superseded());
    await Promise.all([...children].map(item => new Promise(resolveChild => {
      item.child.once("close", resolveChild);
      item.child.kill();
    })));
    if (server) {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    await Promise.allSettled([...inFlight]);
    await rm(runDirectory, { recursive: true, force: true });
    process.exitCode = exitCode;
  }

  function broadcast() {
    const event = `data: ${JSON.stringify({ revision, error: watchError })}\n\n`;
    subscribers.forEach(response => response.write(event));
  }

  function drain() {
    while (!closing && active < 2 && queue.length) {
      queue.sort((first, second) => second.priority - first.priority);
      const item = queue.shift();
      if (item.revision !== revision) {
        item.reject(superseded());
        continue;
      }
      active++;
      item.run().then(item.resolve, item.reject).finally(() => { active--; drain(); });
    }
  }

  function render(templateRoot, payload, target, generation, priority) {
    if (closing || generation !== revision) return Promise.reject(superseded());
    return new Promise((resolveRender, reject) => {
      queue.push({ revision: generation, priority, resolve: resolveRender, reject, run: () => new Promise((resolveRuby, rejectRuby) => {
        const child = spawn(ruby, [
          join(toolRoot, "display", "render.rb"), target.placement, target.device, "--template-root", templateRoot
        ], { cwd: toolRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const running = { child, revision: generation };
        children.add(running);
        let output = "";
        let diagnostics = "";
        let failure;
        const timer = setTimeout(() => {
          failure = new WorkbenchError("The strict Liquid renderer timed out.", 500);
          child.kill();
        }, 15_000);
        child.stdout.setEncoding("utf8").on("data", chunk => {
          output += chunk;
          if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
            failure = new WorkbenchError("Rendered HTML exceeds the local preview budget.", 500);
            child.kill();
          }
        });
        child.stderr.setEncoding("utf8").on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16_384); });
        child.stdin.on("error", error => {
          if (error.code !== "EPIPE") failure = new WorkbenchError("Could not send the scenario to Ruby.", 500);
        });
        child.on("error", () => { failure = new WorkbenchError("Could not start Ruby. Check TRMNL_RUBY and display setup.", 500); });
        child.on("close", code => {
          clearTimeout(timer);
          children.delete(running);
          if (generation !== revision || closing) rejectRuby(superseded());
          else if (failure) rejectRuby(failure);
          else if (code !== 0) rejectRuby(new WorkbenchError(`Strict Liquid rendering failed: ${diagnostics.trim() || `Ruby exit ${code}`}`, 500));
          else resolveRuby(output);
        });
        child.stdin.end(payload);
      }) });
      drain();
    });
  }

  async function markup(side, snapshot, scenario, target, generation, priority) {
    const identity = side === "baseline" ? baseline.commit : snapshot.identity;
    const key = `${side}/${identity}/${scenario.inputHash}/${target.id}`;
    if (markupCache.has(key)) return markupCache.get(key);
    let html;
    try {
      html = await render(side === "baseline" ? baselineDirectory : snapshot.directory,
        scenario.payload, target, generation, priority);
    } catch (error) {
      if (error.status === 409) throw error;
      throw new WorkbenchError(`${side === "baseline" ? "Baseline is incompatible or failed" : "Working-copy render failed"}: ${error.message}`, 500);
    }
    markupCache.set(key, html);
    trimCache(markupCache, 32);
    return html;
  }

  async function comparison(scenarioId, targetId, priority) {
    await currentInputs();
    if (closing) throw superseded();
    if (watchError) throw new WorkbenchError(watchError, 503);
    const generation = revision;
    const scenario = catalogue.get(scenarioId);
    const target = targets.find(item => item.id === targetId);
    if (!scenario) throw new WorkbenchError(`Selected scenario '${scenarioId}' is missing. Restore its JSON file or select another scenario.`);
    if (scenario.error) throw new WorkbenchError(scenario.error);
    if (!target) throw new WorkbenchError("Select one of the four supported workbench targets.");
    let contents;
    try {
      contents = await Promise.all(templateNames.map(name => readFile(join(templateDirectory, name))));
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
      throw new WorkbenchError("Working-copy template inputs are missing or unreadable in display\\src.", 500);
    }
    const identity = hash(contents.map((content, index) => `${templateNames[index]}:${hash(content)}`).join("\n"));
    const directory = await mkdtemp(join(runDirectory, "candidate-"));
    try {
      await Promise.all(contents.map((content, index) => writeFile(join(directory, templateNames[index]), content)));
      const snapshot = { identity, directory };
      const rendered = await Promise.allSettled(["baseline", "candidate"].map(side =>
        markup(side, snapshot, scenario, target, generation, priority)));
      for (const result of rendered) if (result.status === "rejected") throw result.reason;
      if (generation !== revision || closing) throw superseded();
      const id = randomUUID();
      const metadata = {
        id, revision: generation, scenarioId, inputHash: scenario.inputHash, candidateHash: identity,
        baselineCommit: baseline.commit, target, agenda: scenario.agenda
      };
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const [index, side] of ["baseline", "candidate"].entries()) {
        const bridge = `<script type="application/json" id="workbench-render">${jsonForHtml({ ...metadata, side, origin })}</script>
<script>window.workbenchFailures=[];addEventListener("error",event=>{const target=event.target;window.workbenchFailures.push(target!==window?"Asset failed: "+(target.src||target.href||target.tagName):event.message);},true);addEventListener("unhandledrejection",()=>window.workbenchFailures.push("A preview script rejected a promise."));</script>
<script type="module" src="/workbench/preview.mjs"></script>`;
        if (!rendered[index].value.includes("<head>"))
          throw new WorkbenchError(`${side} renderer did not produce the required native HTML document.`, 500);
        documents.set(`${id}/${side}`, rendered[index].value.replace("<head>", `<head>\n${bridge}`));
      }
      trimCache(documents, 32);
      return { ...metadata, previews: { baseline: `/preview/${id}/baseline`, candidate: `/preview/${id}/candidate` } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function currentInputs() {
    let observed;
    do {
      observed = catalogueUpdate;
      await observed;
    } while (observed !== catalogueUpdate);
  }

  function changed() {
    if (watcherFailed) return;
    const change = ++changeSerial;
    catalogueUpdate = Promise.all([loadCatalogue(scenarioDirectory), templateIdentity()]).then(([entries, templates]) => {
      if (change === changeSerial && !closing && !watcherFailed) {
        const scenarios = catalogueIdentity(entries);
        if (scenarios === knownCatalogue && templates === knownTemplates && !watchError) return;
        knownCatalogue = scenarios;
        knownTemplates = templates;
        catalogue = entries;
        watchError = null;
        revision++;
        children.forEach(item => { if (item.revision < revision) item.child.kill(); });
        broadcast();
        drain();
      }
    }, error => {
      if (change === changeSerial && !closing && !watcherFailed) {
        watchError = `Saved inputs could not be read: ${error.message}`;
        revision++;
        broadcast();
      }
    });
  }

  try {
    await mkdir(baselineDirectory);
    await Promise.all(baseline.templates.map((content, index) =>
      writeFile(join(baselineDirectory, templateNames[index]), content)));
    for (const directory of [templateDirectory, scenarioDirectory]) {
      const watcher = watch(directory, (_, name) => {
        if (name && !/\.(liquid|json)$/.test(String(name))) return;
        clearTimeout(debounce);
        debounce = setTimeout(changed, 80);
      });
      watcher.on("error", error => {
        watcherFailed = true;
        changeSerial++;
        watchError = `Live updates stopped (${error.code ?? "watcher failure"}). Restart the workbench.`;
        revision++;
        children.forEach(item => item.child.kill());
        broadcast();
      });
      watchers.push(watcher);
    }

    server = createServer(async (request, response) => {
      const send = (status, body, type = "application/json; charset=utf-8") => {
        if (response.destroyed) return;
        response.writeHead(status, {
          "Content-Type": type, "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"
        }).end(body);
      };
      try {
        const url = new URL(request.url, "http://127.0.0.1");
        if (request.method !== "GET") { send(405, JSON.stringify({ error: "Only GET is supported." })); return; }
        if (url.pathname === "/api/state") {
          await currentInputs();
          send(200, JSON.stringify({
            revision, baselineCommit: baseline.commit, error: watchError, targets,
            scenarios: [...catalogue.values()].map(({ id, name, description, error }) => ({ id, name, description, error }))
          }));
          return;
        }
        if (url.pathname === "/events") {
          response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
          subscribers.add(response);
          response.write(`data: ${JSON.stringify({ revision, error: watchError })}\n\n`);
          response.on("close", () => subscribers.delete(response));
          return;
        }
        if (url.pathname === "/api/comparison") {
          const job = comparison(url.searchParams.get("scenario"),
            url.searchParams.get("target"), url.searchParams.get("overview") === "true" ? 0 : 1);
          inFlight.add(job);
          try {
            send(200, JSON.stringify(await job));
          } finally {
            inFlight.delete(job);
          }
          return;
        }
        const preview = /^\/preview\/([a-f0-9-]+\/(?:baseline|candidate))$/.exec(url.pathname);
        if (preview) {
          const html = documents.get(preview[1]);
          if (!html) throw new WorkbenchError("This render is no longer retained. Refresh the current comparison.", 410);
          send(200, html, "text/html; charset=utf-8");
          return;
        }
        const ui = url.pathname === "/" ? "index.html"
          : /^\/workbench\/(app\.mjs|preview\.mjs|layout-checks\.mjs|styles\.css)$/.exec(url.pathname)?.[1];
        const asset = /^\/(?:css|js)\/3\.4\.3\/plugins\.(?:css|js)$/.test(url.pathname)
          || /^\/fonts\/[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/.test(url.pathname);
        if (!ui && !asset) { send(404, JSON.stringify({ error: "Unknown workbench resource." })); return; }
        const file = ui ? join(toolRoot, "display", "workbench", ui) : join(assets, ...url.pathname.slice(1).split("/"));
        const types = { ".html": "text/html; charset=utf-8", ".mjs": "application/javascript", ".js": "application/javascript",
          ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
        let content;
        try {
          content = await readFile(file);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          throw new WorkbenchError(`Missing ${ui ? "workbench file" : "installed framework/font asset"} ${url.pathname}. ${ui ? "Restore the file." : "Run scripts\\setup-display.ps1."}`, 404);
        }
        send(200, content, types[extname(file)]);
      } catch (error) {
        if (!(error instanceof WorkbenchError)) console.error(`Workbench request failed: ${error.message}`);
        send(error.status ?? 500, JSON.stringify({ error: error.message, revision }));
      }
    });
    await new Promise((resolveListen, reject) => {
      const failed = error => reject(error);
      server.once("error", failed);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", failed);
        resolveListen();
      });
    });
    server.on("error", error => {
      console.error(`Workbench listener failed: ${error.message}`);
      stop(1).catch(failure => { console.error(`Workbench cleanup failed: ${failure.message}`); process.exitCode = 1; });
    });
    heartbeat = setInterval(() => subscribers.forEach(response => response.write(": live\n\n")), 10_000);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
      stop().catch(error => { console.error(`Workbench cleanup failed: ${error.message}`); process.exitCode = 1; });
    });
    console.log(JSON.stringify({
      status: "listening", url: `http://127.0.0.1:${server.address().port}`, baseline_commit: baseline.commit
    }));
  } catch (error) {
    await stop(1);
    throw error;
  }
}

main().catch(error => {
  console.error(`Workbench startup failed: ${error.message}`);
  process.exitCode = 1;
});
