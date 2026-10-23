// Factory-owned node:test reporter injected into proof gates that declare cases. It records which
// named tests ran and how they ended, outside the app, so the factory checks each case itself.
// It appends to SOLOFACTORY_CASE_EVENTS instead of using a reporter destination: tests that spawn their
// own node processes inherit NODE_OPTIONS, and each reopened destination truncated the parent's events.
import { appendFileSync } from "node:fs";

export default async function* caseReporter(source) {
  const out = process.env.SOLOFACTORY_CASE_EVENTS;
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { name, skip, todo } = event.data;
    if (out) appendFileSync(out, JSON.stringify({ type: event.type, name, ...(skip ? { skip: true } : {}), ...(todo ? { todo: true } : {}) }) + "\n");
  }
  yield "";
}
