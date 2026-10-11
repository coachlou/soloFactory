// Factory-owned node:test reporter injected into proof gates that declare cases. It records which
// named tests ran and how they ended, outside the app, so the factory checks each case itself.
export default async function* caseReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { name, skip, todo } = event.data;
    yield JSON.stringify({ type: event.type, name, ...(skip ? { skip: true } : {}), ...(todo ? { todo: true } : {}) }) + "\n";
  }
}
