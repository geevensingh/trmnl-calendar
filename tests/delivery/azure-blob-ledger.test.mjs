import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AzureBlobArtifacts, AzureBlobLedger } from "../../scripts/azure-blob-ledger.mjs";

test("Azure Blob ledger uses an exclusive lease and conditional writes without exposing tokens", async () => {
  const calls = [];
  const initial = {
    schema_version: 1,
    active: false,
    checkpoint: null,
    baselines: { azure: null, trmnl: null },
    queue: [],
    updated_at: null
  };
  let created = false;
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    if (request.method === "GET" && !created) {
      return new Response("", { status: 404 });
    }
    if (request.method === "PUT" && !request.headers["x-ms-lease-action"]) {
      created = true;
      return new Response("", { status: 201, headers: { etag: '"ledger-1"' } });
    }
    if (request.headers["x-ms-lease-action"] === "acquire") {
      return new Response("", { status: 201, headers: { "x-ms-lease-id": "lease-id" } });
    }
    if (request.method === "GET") {
      return new Response(JSON.stringify(initial), {
        status: 200,
        headers: { etag: '"ledger-1"' }
      });
    }
    if (request.method === "PUT" && request.headers["x-ms-lease-action"] === "release") {
      return new Response("", { status: 200 });
    }
    if (request.method === "PUT") {
      return new Response("", { status: 201, headers: { etag: '"ledger-2"' } });
    }
    throw new Error("unexpected_request");
  };
  const ledger = new AzureBlobLedger({
    account: "trmnlcalendar",
    container: "release-control",
    fetchImpl,
    getToken: async () => "synthetic-token"
  });

  const loaded = await ledger.withExclusive(async () => {
    const state = await ledger.read();
    state.active = true;
    await ledger.write(state);
    return state;
  });

  assert.equal(loaded.active, true);
  assert.ok(calls.some(({ request }) => request.headers["x-ms-lease-action"] === "acquire"));
  assert.ok(calls.some(({ request }) => request.headers["x-ms-lease-id"] === "lease-id" &&
    request.headers["If-Match"] === '"ledger-1"'));
  assert.ok(calls.some(({ request }) => request.headers["x-ms-lease-action"] === "release"));
  assert.ok(calls.every(({ request }) => request.headers.Authorization === "Bearer synthetic-token"));
  assert.ok(calls.filter(({ request }) => request.body).every(({ request }) =>
    !request.body.includes("synthetic-token")));
});

test("Azure Blob ledger rejects unsafe target configuration before making requests", () => {
  assert.throws(
    () => new AzureBlobLedger({ account: "bad account", container: "release-control" }),
    { message: "invalid_ledger_configuration" }
  );
});

test("artifact storage is write-once, address-checked, and verifies existing bytes", async () => {
  const content = Buffer.from("retained, synthetic release bundle");
  const calls = [];
  let existing = null;
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    if (request.method === "PUT" && !existing) {
      existing = Buffer.from(request.body);
      return new Response("", { status: 201 });
    }
    if (request.method === "PUT") return new Response("", { status: 412 });
    if (request.method === "GET" && existing) {
      return new Response(existing, {
        status: 200,
        headers: { "content-length": String(existing.length) }
      });
    }
    return new Response("", { status: 404 });
  };
  const artifacts = new AzureBlobArtifacts({
    account: "trmnlcalendar",
    container: "release-control",
    fetchImpl,
    getToken: async () => "synthetic-token"
  });
  const digest = createHash("sha256").update(content).digest("hex");
  const reference = `releases/${"a".repeat(40)}/azure-${digest}.zip`;
  const uploaded = await artifacts.put(reference, content);
  const duplicate = await artifacts.put(reference, content);
  assert.equal(uploaded.sha256, duplicate.sha256);
  assert.equal((await artifacts.get(reference)).sha256, uploaded.sha256);
  await assert.rejects(artifacts.put(reference, Buffer.from("different")), {
    message: "artifact_reference_digest_mismatch"
  });
  await assert.rejects(artifacts.get("releases/../private.zip"), {
    message: "artifact_reference_invalid"
  });
  assert.ok(calls.every(({ request }) => request.headers.Authorization === "Bearer synthetic-token"));
  assert.ok(calls.every(({ url }) => url.includes("release-control/releases/")));
  await assert.rejects(artifacts.get(`releases/${"a".repeat(40)}/azure.zip`), {
    message: "artifact_reference_invalid"
  });
});
