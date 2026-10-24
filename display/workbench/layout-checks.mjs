function visible(element) {
  if (!element || element.closest("[hidden]")) return false;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
}

export function textInsideView(element, truncated = false) {
  if (!visible(element)) return false;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  if (truncated && element.firstChild?.nodeType === Node.TEXT_NODE)
    range.setEnd(element.firstChild, Math.min(12, element.firstChild.length));
  const rectangles = [...range.getClientRects()];
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (ancestor.matches(".view") || /(hidden|clip|auto|scroll)/.test(style.overflow)) {
      const bounds = ancestor.getBoundingClientRect();
      if (rectangles.some(rect => rect.left < bounds.left - 1 || rect.top < bounds.top - 1
        || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1)) return false;
    }
    if (ancestor.matches(".view")) break;
  }
  return rectangles.length > 0;
}

function inside(inner, outer) {
  return inner.left >= outer.left - 1 && inner.top >= outer.top - 1
    && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
}

function separate(first, second) {
  return first.right <= second.left + 1 || second.right <= first.left + 1
    || first.bottom <= second.top + 1 || second.bottom <= first.top + 1;
}

export function rowProblems(rows) {
  const problems = [];
  let previousBottom = 0;
  for (const [index, row] of rows.entries()) {
    const bounds = row.getBoundingClientRect();
    const time = row.querySelector(".agenda-time .label");
    const title = row.querySelector("td .title");
    if (!time || !title) {
      problems.push(`Row ${index + 1} is missing essential time or title text.`);
      continue;
    }
    const timeBounds = time.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    if (bounds.top < previousBottom - 1) problems.push(`Row ${index + 1} overlaps its predecessor.`);
    if (!inside(timeBounds, bounds) || !inside(titleBounds, bounds))
      problems.push(`Row ${index + 1} does not contain its time and title.`);
    if (!separate(timeBounds, titleBounds)) problems.push(`Row ${index + 1} has overlapping time and title.`);
    previousBottom = bounds.bottom;
  }
  return problems;
}

export function checkLayout(document, agenda, target, allowLegacy = false) {
  const findings = [];
  const add = (rule, passed, message) => findings.push({ rule, passed: Boolean(passed), message });
  const requireText = (element, name, truncated = false) =>
    add("clipping", textInsideView(element, truncated), `${name} must be visible inside its native view.`);
  const root = document.querySelector(".agenda");
  const view = root?.closest(".view");
  const screen = document.querySelector(".screen");
  add("structure", root && view && screen, "The production agenda, view, and screen must exist.");
  if (!root || !view || !screen) return findings;
  const legacy = allowLegacy && Boolean(view.querySelector(".agenda-footer"));
  if (!legacy)
    add("structure", !view.querySelector(".agenda-footer, .agenda-overflow, .title_bar"),
      "Counts and source information must not reserve standalone overflow or footer space.");

  const bounds = screen.getBoundingClientRect();
  add("dimensions", Math.abs(bounds.width - target.width) < 1 && Math.abs(bounds.height - target.height) < 1,
    `The native screen must remain ${target.width} x ${target.height}.`);
  add("dimensions", inside(view.getBoundingClientRect(), bounds), "The native placement must fit its screen.");
  add("readiness", root.dataset.agendaReady === "true" && window.TRMNL_PLUGINS_READY === true,
    "Production fitting and native framework readiness must both be complete.");
  add("state", root.dataset.agendaState === agenda.state, "The displayed source state must match the scenario.");

  const source = view.querySelector(".agenda-source");
  requireText(source, "Source-success information");
  const time = source?.querySelector("[data-agenda-source]");
  if (agenda.source_succeeded_at === null) {
    add("source", !time && source?.textContent.includes("No successful source check"),
      "Absent source success must be explicit, without an invented timestamp.");
  } else {
    add("source", time?.getAttribute("datetime") === agenda.source_succeeded_at && time.textContent.trim().length > 0,
      "The original supplied source-success timestamp must be retained and formatted.");
    requireText(time, "Source-success timestamp");
  }

  if (agenda.state === "error") {
    add("state", root.querySelectorAll(".agenda-day").length === 0,
      "An error must not display healthy counts or commitments.");
    add("state", root.textContent.includes(agenda.error.message) && root.textContent.includes(agenda.error.code),
      "The supplied error message and code must be present.");
    for (const child of root.children) requireText(child, "Error information");
    return findings;
  }

  if (agenda.state === "stale") {
    requireText(root.querySelector(".agenda-warning"), "Stale warning");
    add("state", root.querySelector(".agenda-warning")?.textContent.includes(agenda.error.message),
      "The stale source warning must retain the supplied explanation.");
  } else {
    add("state", !root.querySelector(".agenda-warning"), "Current data must not acquire a stale warning.");
  }

  const visibleCounts = {};
  for (const name of ["primary", "secondary"]) {
    const day = agenda[name];
    const element = root.querySelector(`.agenda-${name}`);
    add("structure", element, `The ${name} day must remain present.`);
    if (!element) continue;
    const heading = element.querySelector(".agenda-heading .title");
    const count = element.querySelector(".agenda-heading .label");
    requireText(heading, `${name} date label`);
    add("dates", heading?.textContent.trim() === day.label, `The supplied ${name} day label must not change.`);

    const rows = [...element.querySelectorAll("tbody tr")];
    const shown = rows.filter(visible);
    visibleCounts[name] = shown.length;
    requireText(count, `${name} count or empty message`);
    const noun = day.eligible_total === 1 ? "event" : "events";
    const expected = legacy ? `${day.eligible_total} eligible ${noun}`
      : day.eligible_total === 0 ? "No remaining events"
      : shown.length === day.eligible_total ? `${day.eligible_total} ${noun}`
      : `${shown.length} of ${day.eligible_total} ${noun} shown`;
    add("counts", count?.textContent.trim() === expected,
      `The ${name} count must agree with displayed rows and the complete eligible total: ${expected}.`);
    if (!legacy && heading && count) {
      const dateBox = heading.getBoundingClientRect();
      const countBox = count.getBoundingClientRect();
      const headerBox = element.querySelector(".agenda-heading").getBoundingClientRect();
      add("heading", Math.abs(dateBox.left - headerBox.left) < 1 && countBox.left >= dateBox.right
        && countBox.left - dateBox.right <= 12 * target.width / screen.clientWidth
        && Math.max(dateBox.top, countBox.top) < Math.min(dateBox.bottom, countBox.bottom),
      `${name} date and count/empty message must share a left-aligned line.`);
      if (name === "primary" && source) {
        const sourceBox = source.getBoundingClientRect();
        add("source", source.closest(".agenda-heading") === element.querySelector(".agenda-heading")
          && separate(sourceBox, dateBox) && separate(sourceBox, countBox),
        "Source-success information must be inside the primary header, separate from its date/count.");
        add("source", view.clientWidth < 600
          ? sourceBox.top >= Math.max(dateBox.bottom, countBox.bottom) - 1
          : Math.abs(sourceBox.right - headerBox.right) < 1,
        "Narrow source metadata uses a second header line; wide source metadata stays at the right.");
      }
    }
    add("admission", rows.length === day.occurrences.length && shown.every((row, index) => row === rows[index]),
      `The ${name} rows must retain the supplied order and admit a prefix.`);
    const problems = rowProblems(shown);
    add("overlap", problems.length === 0, problems.join(" ") || `${name} occurrence rows do not overlap.`);
    for (const [index, row] of shown.entries()) {
      const timing = row.querySelector(".agenda-time .label");
      const title = row.querySelector("td .title");
      requireText(timing, `${name} row ${index + 1} time`);
      requireText(title, `${name} row ${index + 1} title`, true);
      add("readability", timing && title && parseFloat(getComputedStyle(timing).fontSize) >= 20
        && parseFloat(getComputedStyle(title).fontSize) >= 20, `${name} essential rows must retain readable logical type.`);
      add("content", title?.textContent === day.occurrences[index]?.title,
        `${name} row ${index + 1} must retain the supplied title as text.`);
      if (day.occurrences[index]?.time_kind === "all_day")
        add("all-day", timing?.textContent.trim() === "All day" && !timing.hasAttribute("data-agenda-start"),
          "All-day entries must remain date-only, not midnight meetings.");
      if (source)
        add("overlap", separate(row.getBoundingClientRect(), source.getBoundingClientRect()),
          `${name} row ${index + 1} must not overlap source information.`);
    }
    if (day.eligible_total === 0) requireText(element.querySelector(".agenda-empty"), `${name} empty state`);
    if (legacy) {
      const remaining = day.eligible_total - shown.length;
      const overflow = element.querySelector(".agenda-overflow");
      if (visible(overflow)) {
        add("overflow", remaining > 0 && overflow.textContent.trim() === `+${remaining} more`,
          `${name} overflow must be the complete total minus visible rows.`);
        requireText(overflow, `${name} overflow`);
      } else if (name === "primary" && remaining > 0) {
        add("overflow", false, "Undisplayed primary commitments require visible truthful overflow.");
      }
    }
  }
  add("priority", !visibleCounts.secondary || visibleCounts.primary === agenda.primary.occurrences.length,
    "Secondary details must not displace supplied primary rows.");
  return findings;
}
