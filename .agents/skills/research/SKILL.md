---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Give a **background agent** a bounded question and the claims or capabilities it must establish, so you keep working while it reads.

Its job:

1. **Establish the target.** For versioned software, use the user's explicit target or the project's declared/locked version. If neither exists, verify and record the current stable release. Resolve its release/tag and, where available, commit SHA before investigating APIs or behavior. Keep prerelease findings separate.
2. **Follow primary sources.** Use official docs, source code, specs, and first-party APIs. For the selected version, inspect versioned documentation and tagged source/tests; default-branch search is discovery, not evidence for a released version. Label comparisons by version. For unversioned services, record the access date and relevant product, runtime, or tier.
3. **Establish behavior.** Distinguish API or serialization support from effective behavior, and documented/source-inferred behavior from execution with the selected package/runtime. Classify each requested claim or capability as **supported**, **unsupported**, or **unknown**. Support the first two with primary evidence for the selected version or service context; mark inconclusive evidence unknown rather than inferring support or absence.
4. **Leave one cited note.** Write a single Markdown file using the repo's existing research-note convention, or choose a sensible location and report it. Include the target versions/refs and a compact matrix of claim/capability, status, primary evidence, and limitations. For each unknown, state the smallest remaining verification.

Research is complete when every requested claim is classified with target-matched primary evidence or an explicit unknown with a next verification. Keep further investigation scoped to those gaps.
