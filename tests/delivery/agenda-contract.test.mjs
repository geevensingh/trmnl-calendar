import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { AgendaContractError, validateAgenda } from "../../scripts/agenda-contract.mjs";

const directory = new URL("../../display/scenarios/", import.meta.url);
const reference = JSON.parse(await readFile(new URL("reference.json", directory), "utf8")).agenda;
const expectations = ["definite", "likely", "maybe", "unlikely", "unknown"];

function agendaWith(expectation, allDay = false, day = "primary") {
  const agenda = structuredClone(reference);
  agenda.primary.eligible_total = 0;
  agenda.primary.occurrences = [];
  agenda.secondary.eligible_total = 0;
  agenda.secondary.occurrences = [];
  agenda[day].eligible_total = 1;
  agenda[day].occurrences = [{
    time_kind: allDay ? "all_day" : "timed",
    id: "synthetic",
    title: "<svg onload=window.pwn=1> & an unbroken WWWWWWWWWWWWWWWWWWWWWWWWW",
    participation_expectation: expectation,
    location: null,
    ...(allDay
      ? { start_date: "2026-10-23", end_date_exclusive: "2026-10-27" }
      : { start_at: "2026-10-26T18:00:00Z", end_at: "2026-10-26T19:00:00Z" })
  }];
  return agenda;
}

test("schema 2 preserves every controlled label and original text for both occurrence kinds and days", () => {
  for (const expectation of expectations)
    for (const allDay of [false, true])
      for (const day of ["primary", "secondary"]) {
        const agenda = agendaWith(expectation, allDay, day);
        const original = structuredClone(agenda);
        assert.equal(validateAgenda(agenda), agenda);
        assert.deepEqual(agenda, original);
      }
});

test("missing and invalid participation values fail explicitly without inventing a default", () => {
  for (const allDay of [false, true])
    for (const day of ["primary", "secondary"])
      for (const value of [undefined, null, "", "Likely", "accepted", 1, {}, ["unknown"]]) {
        const agenda = agendaWith(value, allDay, day);
        if (value === undefined) delete agenda[day].occurrences[0].participation_expectation;
        assert.throws(() => validateAgenda(agenda), error =>
          error instanceof AgendaContractError
          && error.path === `agenda.${day}.occurrences[0].participation_expectation`
          && error.code === "invalid_polling_contract");
      }
});

test("old and future schemas are rejected rather than relabeled as schema 2", () => {
  for (const version of [undefined, 1, 3, "2"]) {
    const agenda = agendaWith("unknown");
    agenda.schema_version = version;
    assert.throws(() => validateAgenda(agenda), AgendaContractError);
  }
});

test("participation never relaxes privacy, timing, complete totals, freshness or error shape", () => {
  for (const mutate of [
    agenda => { agenda.primary.occurrences[0].attendees = ["CONFIDENTIAL_ATTENDEE"]; },
    agenda => { agenda.primary.occurrences[0].organizer = "CONFIDENTIAL_ORGANIZER"; },
    agenda => { agenda.primary.occurrences[0].end_at = "2026-10-26T18:00:00Z"; },
    agenda => { agenda.primary.eligible_total = 0; },
    agenda => { agenda.source_succeeded_at = null; },
    agenda => { agenda.generated_at = "2026-10-23T18:15:00Z"; },
    agenda => { agenda.state = "error"; agenda.error = { code: "source_invalid", message: "Invalid source." }; }
  ]) {
    const agenda = agendaWith("unknown");
    mutate(agenda);
    assert.throws(() => validateAgenda(agenda), AgendaContractError);
  }
});

test("every catalogue scenario uses the strict version-2 contract and synthetic examples cover all labels", async () => {
  const supplied = new Set();
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".json"))) {
    const scenario = JSON.parse(await readFile(new URL(file, directory), "utf8"));
    assert.equal(scenario.id, file.slice(0, -5));
    assert.doesNotThrow(() => validateAgenda(scenario.agenda), file);
    for (const day of ["primary", "secondary"])
      for (const occurrence of scenario.agenda[day].occurrences)
        supplied.add(occurrence.participation_expectation);
  }
  assert.deepEqual([...supplied].sort(), [...expectations].sort());
});
