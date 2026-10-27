import { relative } from "node:path";

export default async function* timingReporter(events) {
  let count = 0;
  const files = new Set();
  for await (const { type, data } of events) {
    if (type === "test:pass" || type === "test:fail") {
      if (++count > 100_000) throw new Error("Node timing inventory exceeds diagnostic limit.");
      const file = data.file ? relative(process.cwd(), data.file) : null;
      if (file) files.add(file);
      yield JSON.stringify({
        kind: "test", name: data.name, file,
        nesting: data.nesting, type: data.details.type ?? "test",
        result: type === "test:pass" ? "passed" : "failed",
        duration_ms: data.details.duration_ms
      }) + "\n";
    } else if (type === "test:summary" && data.file === undefined) {
      yield JSON.stringify({
        kind: "summary", tests: data.counts.tests, passed: data.counts.passed,
        failed: data.counts.failed, cancelled: data.counts.cancelled,
        skipped: data.counts.skipped, todo: data.counts.todo,
        files: [...files].sort(),
        duration_ms: data.duration_ms
      }) + "\n";
    }
  }
}
