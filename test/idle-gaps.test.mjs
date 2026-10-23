// The time-left estimate counts running time only: pauses, stops and long silences are idle gaps.
import test from "node:test";
import assert from "node:assert/strict";
import { idleGapsOf } from "../src/store.mjs";

const line = (at, type) => JSON.stringify({ at, type });

test("a pause, a stop and an hour of silence are idle; ordinary gaps are not", () => {
  const text = [
    line("2026-10-14T00:00:00Z", "job.created"),
    line("2026-10-14T00:10:00Z", "stage.started"),
    line("2026-10-14T00:20:00Z", "job.paused"),
    line("2026-10-14T03:20:00Z", "job.resumed"),
    line("2026-10-14T03:30:00Z", "job.failed"),
    line("2026-10-14T03:45:00Z", "job.resumed"),
    line("2026-10-14T05:00:00Z", "stage.started"),
    "not json",
    line("2026-10-14T05:05:00Z", "stage.finished"),
  ].join("\n");
  const ms = (iso) => Date.parse(iso);
  assert.deepEqual(idleGapsOf(text), [
    [ms("2026-10-14T00:20:00Z"), ms("2026-10-14T03:20:00Z")],
    [ms("2026-10-14T03:30:00Z"), ms("2026-10-14T03:45:00Z")],
    [ms("2026-10-14T03:45:00Z"), ms("2026-10-14T05:00:00Z")],
  ]);
});
