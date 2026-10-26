export const agendaSchemaVersion = 2;

export class AgendaContractError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.code = code;
    this.path = path;
  }
}

function reject(path, message, code = "invalid_polling_contract") {
  throw new AgendaContractError(code, path, message);
}

function fields(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every(name => Object.hasOwn(value, name))
    && Object.keys(value).every(name => required.includes(name) || optional.includes(name));
}

function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
    return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function instant(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !calendarDate(value.slice(0, 10)) || Number(value.slice(11, 13)) >= 24)
    return NaN;
  return Date.parse(value);
}

function instantTicks(value) {
  const fraction = (/\.(\d{1,7})/.exec(value)?.[1] ?? "").padEnd(7, "0");
  return BigInt(instant(value)) * 10_000n + BigInt(fraction.slice(3));
}

export function validateAgenda(data) {
  if (!fields(data, ["schema_version", "state", "time_zone", "generated_at",
    "source_succeeded_at", "primary", "secondary", "error"]))
    reject("agenda", "supply exactly the agenda fields.");
  if (![1, agendaSchemaVersion].includes(data.schema_version))
    reject("agenda.schema_version", `only schemas 1 and ${agendaSchemaVersion} are supported.`);
  if (!["current", "stale", "error"].includes(data.state))
    reject("agenda.state", "use current, stale, or error.");
  if (data.time_zone !== "America/Los_Angeles")
    reject("agenda.time_zone", "use America/Los_Angeles.");
  if (!Number.isFinite(instant(data.generated_at)))
    reject("agenda.generated_at", "supply a fixed offset-bearing timestamp.");
  if (data.state === "current" ? data.error !== null
    : !fields(data.error, ["code", "message"])
    || typeof data.error.code !== "string" || typeof data.error.message !== "string")
    reject("agenda.error", "use null for current, or a code/message object for stale and error.");

  for (const name of ["primary", "secondary"]) {
    const day = data[name];
    const path = `agenda.${name}`;
    if (!fields(day, ["date", "label", "eligible_total", "occurrences"]))
      reject(path, "supply exactly date, label, eligible_total, and occurrences.");
    if (!calendarDate(day.date)) reject(`${path}.date`, "supply an ISO calendar date.");
    if (typeof day.label !== "string") reject(`${path}.label`, "supply a literal date label.");
    if (!Array.isArray(day.occurrences)) reject(`${path}.occurrences`, "supply an array.");
    if (data.state === "error" ? day.eligible_total !== null || day.occurrences.length !== 0
      : !Number.isSafeInteger(day.eligible_total) || day.eligible_total < day.occurrences.length)
      reject(`${path}.eligible_total`, "error requires null and no occurrences; otherwise use a complete nonnegative total at least as large as the supplied array.");

    for (const [index, occurrence] of day.occurrences.entries()) {
      const occurrencePath = `${path}.occurrences[${index}]`;
      if (occurrence === null || typeof occurrence !== "object" || Array.isArray(occurrence))
        reject(occurrencePath, "supply a timed or all_day occurrence object.");
      const allDay = occurrence.time_kind === "all_day";
      const timing = allDay ? ["start_date", "end_date_exclusive"] : ["start_at", "end_at"];
      const optional = !allDay && data.schema_version === 2 ? ["location", "emphasis"] : ["location"];
      if (!fields(occurrence, ["time_kind", "id", "title", ...timing], optional)
        || !["all_day", "timed"].includes(occurrence.time_kind))
        reject(occurrencePath, "supply the fields for exactly one timed or all_day occurrence.");
      if (!allDay && occurrence.emphasis !== undefined
        && !["in_progress", "upcoming"].includes(occurrence.emphasis))
        reject(`${occurrencePath}.emphasis`, "use in_progress or upcoming on a timed occurrence.");
      if (typeof occurrence.id !== "string" || !occurrence.id.length)
        reject(`${occurrencePath}.id`, "supply a nonempty opaque identifier.");
      if (typeof occurrence.title !== "string")
        reject(`${occurrencePath}.title`, "supply a string.");
      if (occurrence.location !== undefined && occurrence.location !== null && typeof occurrence.location !== "string")
        reject(`${occurrencePath}.location`, "supply a string or null, or omit the field.");
      if (allDay ? !calendarDate(occurrence.start_date) || !calendarDate(occurrence.end_date_exclusive)
        || occurrence.start_date >= occurrence.end_date_exclusive
        : !Number.isFinite(instant(occurrence.start_at)) || !Number.isFinite(instant(occurrence.end_at))
        || instant(occurrence.end_at) <= instant(occurrence.start_at))
        reject(occurrencePath, "supply valid timing with an exclusive end strictly after the start.");
    }
  }

  if (data.source_succeeded_at === null ? data.state !== "error"
    : !Number.isFinite(instant(data.source_succeeded_at)))
    reject("agenda.source_succeeded_at", "supply a valid source-success timestamp; only error may use null.", "invalid_source_success_time");
  const sourceAge = data.source_succeeded_at === null ? null
    : instantTicks(data.generated_at) - instantTicks(data.source_succeeded_at);
  if (data.state === "current" && !(sourceAge >= 0n && sourceAge < 9_000_000_000n))
    reject("agenda.source_succeeded_at", "current source success must precede generated_at by less than 15 minutes.", "invalid_source_success_time");
  if (data.state === "stale" && !(sourceAge >= 0n && sourceAge < 36_000_000_000n))
    reject("agenda.source_succeeded_at", "stale source success must precede generated_at by less than one hour.", "invalid_source_success_time");
  return data;
}
