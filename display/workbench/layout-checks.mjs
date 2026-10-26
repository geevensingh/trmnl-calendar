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
  let rectangles = [...range.getClientRects()];
  const elementBounds = element.getBoundingClientRect();
  if (truncated) {
    const style = getComputedStyle(element);
    if (style.textOverflow !== "ellipsis" || style.whiteSpace !== "nowrap"
      || !/(hidden|clip)/.test(style.overflowX)
      || rectangles.some(rect => rect.top < elementBounds.top - 1 || rect.bottom > elementBounds.bottom + 1))
      return false;
    rectangles = rectangles.map(rect => ({
      left: Math.max(rect.left, elementBounds.left), right: Math.min(rect.right, elementBounds.right),
      top: rect.top, bottom: rect.bottom
    }));
  }
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (ancestor.matches(".view") || /(hidden|clip|auto|scroll)/.test(style.overflow)) {
      const bounds = ancestor.getBoundingClientRect();
      if (truncated && !inside(elementBounds, bounds)) return false;
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
    const range = row.ownerDocument.createRange();
    range.selectNodeContents(title);
    const rectangles = [...range.getClientRects()];
    if (title.clientHeight > Math.ceil(parseFloat(getComputedStyle(title).lineHeight)) + 1
      || title.scrollHeight > title.clientHeight + 1
      || rectangles.some(rect => Math.abs(rect.top - rectangles[0].top) > 1))
      problems.push(`Row ${index + 1} title must occupy exactly one title line without vertical clipping.`);
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
    add("admission", rows.length === day.occurrences.length
      && rows.every((row, index) => row.dataset.agendaId === day.occurrences[index]?.id),
    `The ${name} rows must retain the supplied order.`);
    const problems = rowProblems(shown);
    add("overlap", problems.length === 0, problems.join(" ") || `${name} occurrence rows do not overlap.`);
    for (const [index, row] of rows.entries()) {
      if (!visible(row)) continue;
      const timing = row.querySelector(".agenda-time .label");
      const title = row.querySelector("td .title");
      const occurrence = day.occurrences[index];
      requireText(timing, `${name} row ${index + 1} time`);
      requireText(title, `${name} row ${index + 1} title`, true);
      add("readability", timing && title && parseFloat(getComputedStyle(timing).fontSize) >= 20
        && parseFloat(getComputedStyle(title).fontSize) >= 20, `${name} essential rows must retain readable logical type.`);
      add("content", title?.textContent === occurrence?.title,
        `${name} row ${index + 1} must retain the supplied title as text.`);
      const expectedEmphasis = occurrence?.emphasis ?? null;
      const actualEmphasis = row.dataset.agendaEmphasis ?? null;
      add("emphasis", actualEmphasis === expectedEmphasis,
        `${name} row ${index + 1} must preserve its adapter-selected emphasis.`);
      if (expectedEmphasis) {
        const status = row.querySelector(".agenda-status");
        const cells = [...row.querySelectorAll("td")];
        const label = expectedEmphasis === "in_progress" ? "IN PROGRESS" : "UPCOMING";
        requireText(status, `${name} row ${index + 1} status`);
        add("emphasis", status?.textContent.trim() === label,
          `${name} row ${index + 1} must display its explicit ${label} status.`);
        add("emphasis", cells.length === 2 && cells.every(cell =>
          getComputedStyle(cell).backgroundColor === "rgb(0, 0, 0)"
          && getComputedStyle(cell).color === "rgb(255, 255, 255)")
          && getComputedStyle(timing).color === "rgb(255, 255, 255)"
          && getComputedStyle(title).color === "rgb(255, 255, 255)",
        `${name} row ${index + 1} must use a black card with white essential text.`);
        add("readability", parseFloat(getComputedStyle(title).fontSize) > 21
          && parseInt(getComputedStyle(title).fontWeight, 10) >= 700,
        `${name} row ${index + 1} emphasized title must be larger and bold.`);
      }
      if (occurrence?.time_kind === "all_day")
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
  const allEmphasizedVisible = ["primary", "secondary"].every(name =>
    [...root.querySelectorAll(`.agenda-${name} tbody tr[data-agenda-emphasis]`)].every(visible));
  const ordinaryVisible = ["primary", "secondary"].some(name =>
    [...root.querySelectorAll(`.agenda-${name} tbody tr:not([data-agenda-emphasis])`)].some(visible));
  add("priority", !ordinaryVisible || allEmphasizedVisible,
    "Ordinary rows must not be admitted ahead of an emphasized event.");
  const secondaryOrdinaryVisible = [...root.querySelectorAll(".agenda-secondary tbody tr:not([data-agenda-emphasis])")]
    .some(visible);
  add("priority", !secondaryOrdinaryVisible || visibleCounts.primary === agenda.primary.occurrences.length,
    "Ordinary secondary details must not displace primary rows.");
  return findings;
}
