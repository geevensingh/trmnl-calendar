import { ReceiptError, requireEvidence } from "./receipt-git.mjs";

export function github(options) {
  const prefix = `/repos/${options.repository}`;
  async function request(path, method = "GET", payload) {
    let response, text;
    try {
      response = await fetch(`${options.api}${prefix}${path}`, {
        method, headers: {
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, "Content-Type": "application/json"
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000), redirect: "error"
      });
      text = await response.text();
    } catch {
      throw new ReceiptError(method === "GET" ? "github_evidence_unavailable" : "receipt_write_failed");
    }
    requireEvidence(response.ok, method === "GET" ? "github_evidence_unavailable" : "receipt_write_failed");
    requireEvidence(text.length <= 8 * 1024 * 1024, "github_response_too_large");
    try { return JSON.parse(text); } catch { throw new ReceiptError("github_evidence_invalid"); }
  }
  async function pages(path, field) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const response = await request(`${path}?per_page=100&page=${page}`);
      const items = field ? response[field] : response;
      requireEvidence(Array.isArray(items) && items.length <= 100, "github_page_invalid");
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new ReceiptError("github_pagination_limit");
  }
  return { request, pages };
}
