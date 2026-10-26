import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const apiVersion = "2023-11-03";
const leaseDurationSeconds = 60;
const renewIntervalMilliseconds = 20_000;
const maximumArtifactBytes = 100 * 1024 * 1024;

function azureCliEnvironment() {
  const env = {};
  for (const key of [
    "PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG", "LC_ALL",
    "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "SystemRoot"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function safeStatus(response) {
  return response.status === 404 ? "blob_missing" : `storage_http_${response.status}`;
}

async function azureCliToken() {
  try {
    const { stdout } = await execFileAsync("az", [
      "account", "get-access-token",
      "--resource", "https://storage.azure.com/",
      "--query", "accessToken",
      "--output", "tsv",
      "--only-show-errors"
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: azureCliEnvironment(),
      maxBuffer: 1024 * 1024
    });
    const token = stdout.trim();
    if (!token || /\s/.test(token)) throw new Error("token_unavailable");
    return token;
  } catch {
    throw new Error("storage_authentication_failed");
  }
}

function storageUrl(account, container, blob) {
  return `https://${account}.blob.core.windows.net/${container}/${blob}`;
}

export class AzureBlobLedger {
  #url;
  #fetch;
  #getToken;
  #etag = null;
  #leaseId = null;

  constructor({ account, container, blob = "release-ledger.json", fetchImpl = fetch, getToken } = {}) {
    if (
      !/^[a-z0-9]{3,24}$/.test(account ?? "") ||
      !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container ?? "") ||
      !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(blob)
    ) throw new Error("invalid_ledger_configuration");
    this.#url = storageUrl(account, container, blob);
    this.#fetch = fetchImpl;
    this.#getToken = getToken ?? azureCliToken;
  }

  async #request(method, { query = "", headers = {}, body, allowStatuses = [] } = {}) {
    const token = await this.#getToken();
    let response;
    try {
      response = await this.#fetch(`${this.#url}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-ms-date": new Date().toUTCString(),
        "x-ms-version": apiVersion,
        ...headers
      },
      body,
      signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new Error("storage_request_failed");
    }
    if (!response.ok && !allowStatuses.includes(response.status)) {
      const error = new Error(safeStatus(response));
      error.code = safeStatus(response);
      throw error;
    }
    return response;
  }

  async #ensureBlob() {
    const read = await this.#request("GET", { allowStatuses: [404] });
    if (read.status !== 404) {
      await read.body?.cancel();
      return;
    }
    await read.body?.cancel();
    await this.#request("PUT", {
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "If-None-Match": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        schema_version: 1,
        active: false,
        checkpoint: null,
        baselines: { azure: null, trmnl: null },
        queue: [],
        updated_at: null
      }),
      allowStatuses: [409, 412]
    });
  }

  async #acquireLease() {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await this.#ensureBlob();
      const proposed = randomUUID();
      const response = await this.#request("PUT", {
        query: "?comp=lease",
        headers: {
          "x-ms-lease-action": "acquire",
          "x-ms-lease-duration": String(leaseDurationSeconds),
          "x-ms-proposed-lease-id": proposed
        },
        allowStatuses: [409]
      });
      if (response.status !== 409) {
        const leaseId = response.headers.get("x-ms-lease-id");
        if (!leaseId) throw new Error("storage_lease_identity_missing");
        this.#leaseId = leaseId;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    throw new Error("storage_lease_busy");
  }

  async #renewLease() {
    await this.#request("PUT", {
      query: "?comp=lease",
      headers: {
        "x-ms-lease-action": "renew",
        "x-ms-lease-id": this.#leaseId
      }
    });
  }

  async #releaseLease() {
    if (!this.#leaseId) return;
    const leaseId = this.#leaseId;
    this.#leaseId = null;
    await this.#request("PUT", {
      query: "?comp=lease",
      headers: {
        "x-ms-lease-action": "release",
        "x-ms-lease-id": leaseId
      }
    });
  }

  async withExclusive(operation) {
    await this.#acquireLease();
    let heartbeatError = null;
    let operationError = null;
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing || heartbeatError) return;
      renewing = true;
      try {
        await this.#renewLease();
      } catch {
        heartbeatError = new Error("storage_lease_lost");
      } finally {
        renewing = false;
      }
    }, renewIntervalMilliseconds);
    heartbeat.unref?.();
    let result;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (renewing) {
        while (renewing) await new Promise(resolve => setTimeout(resolve, 10));
      }
      const failures = operationError ? [operationError] : [];
      try {
        await this.#releaseLease();
      } catch {
        failures.push(new Error("storage_lease_release_failed"));
      }
      if (heartbeatError) failures.push(heartbeatError);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "storage_lease_cleanup_failed");
      }
    }
    return result;
  }

  async read() {
    if (!this.#leaseId) throw new Error("storage_lease_required");
    const response = await this.#request("GET", {
      headers: { "x-ms-lease-id": this.#leaseId }
    });
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("storage_etag_missing");
    this.#etag = etag;
    try {
      return await response.json();
    } catch {
      throw new Error("ledger_invalid");
    }
  }

  async write(state) {
    if (!this.#leaseId || !this.#etag) throw new Error("storage_lease_required");
    const response = await this.#request("PUT", {
      headers: {
        "x-ms-lease-id": this.#leaseId,
        "If-Match": this.#etag,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(state)
    });
    this.#etag = response.headers.get("etag");
    if (!this.#etag) throw new Error("storage_etag_missing");
  }
}

export class AzureBlobArtifacts {
  #account;
  #container;
  #fetch;
  #getToken;

  constructor({ account, container, fetchImpl = fetch, getToken } = {}) {
    if (
      !/^[a-z0-9]{3,24}$/.test(account ?? "") ||
      !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container ?? "")
    ) throw new Error("invalid_artifact_storage_configuration");
    this.#account = account;
    this.#container = container;
    this.#fetch = fetchImpl;
    this.#getToken = getToken ?? azureCliToken;
  }

  #url(reference) {
    if (
      typeof reference !== "string" ||
      !/^releases\/[a-f0-9]{40}\/(?:azure-[a-f0-9]{64}\.zip|trmnl-[a-f0-9]{64}\.tar)$/.test(reference)
    ) throw new Error("artifact_reference_invalid");
    const encoded = reference.split("/").map(encodeURIComponent).join("/");
    return storageUrl(this.#account, this.#container, encoded);
  }

  async #request(method, reference, { headers = {}, body, statuses = [] } = {}) {
    const url = this.#url(reference);
    const token = await this.#getToken();
    let response;
    try {
      response = await this.#fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-ms-date": new Date().toUTCString(),
        "x-ms-version": apiVersion,
        ...headers
      },
      body,
      signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new Error("artifact_storage_request_failed");
    }
    if (!response.ok && !statuses.includes(response.status)) {
      const error = new Error(safeStatus(response));
      error.code = safeStatus(response);
      throw error;
    }
    return response;
  }

  async put(reference, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumArtifactBytes) {
      throw new Error("artifact_size_invalid");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const addressedDigest = reference.match(/(?:azure|trmnl)-([a-f0-9]{64})\.(?:zip|tar)$/)?.[1];
    if (addressedDigest !== digest) throw new Error("artifact_reference_digest_mismatch");
    const response = await this.#request("PUT", reference, {
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "If-None-Match": "*",
        "Content-Type": "application/octet-stream"
      },
      body: bytes,
      statuses: [409, 412]
    });
    if (response.status === 409 || response.status === 412) {
      const existing = await this.get(reference);
      if (existing.sha256 !== digest || existing.bytes.length !== bytes.length) {
        throw new Error("artifact_identity_conflict");
      }
    }
    return { reference, sha256: digest, bytes: bytes.length };
  }

  async get(reference) {
    const response = await this.#request("GET", reference);
    const advertisedLength = Number(response.headers.get("content-length"));
    if (advertisedLength > maximumArtifactBytes) {
      await response.body?.cancel();
      throw new Error("artifact_size_invalid");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumArtifactBytes) throw new Error("artifact_size_invalid");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const addressedDigest = reference.match(/(?:azure|trmnl)-([a-f0-9]{64})\.(?:zip|tar)$/)?.[1];
    if (addressedDigest !== sha256) throw new Error("artifact_digest_mismatch");
    return {
      bytes,
      sha256
    };
  }
}
