import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/store.mjs';
import { SoloFactory, continuationAction, withContinuation } from '../src/factory.mjs';
import { createFixtureProvider } from '../src/fixture-provider.mjs';
import { digest, sourceBaseline, validateRecoveryPlan, validateRecoveryApproval } from '../src/feature-recovery.mjs';

const request = { id: 'request', contractDigest: 'frozen', checks: [{ id: 'MH-3' }, { id: 'SC-2' }] };
const plan = () => ({ version: 1, requestId: 'request', contractDigest: 'frozen', slices: [
  { id: 'BROWSE', title: 'Browse', objective: 'Complete browser controls', checks: ['MH-3'], acceptance: ['Execute browser controls test'], dependsOn: [] },
  { id: 'RESTART', title: 'Restart', objective: 'Verify durable workflow', checks: ['SC-2'], acceptance: ['Execute browser restart test'], dependsOn: ['BROWSE'] },
] });
test('recovery plan covers original failed checks without requiring a new skeleton', () => {
  assert.equal(validateRecoveryPlan(plan(), request).slices[0].id, 'BROWSE');
});
for (const [name, mutate] of Object.entries({
  omitted: p => p.slices.pop(), duplicate: p => p.slices[1].checks.push('MH-3'),
  unknown: p => p.slices[1].checks = ['SC-99'], cycle: p => p.slices[0].dependsOn = ['RESTART'],
  stale: p => p.contractDigest = 'other', thin: p => p.slices[0].acceptance = [],
})) test(`rejects ${name} recovery plans`, () => { const p = plan(); mutate(p); assert.throws(() => validateRecoveryPlan(p, request)); });

const v2Request = { ...request, jobId: 'job', checks: [{ id: 'MH-3', text: 'Browse' }, { id: 'SC-2', text: 'Restart' }], sources: [{ path: '.factory/PRD.md' }, { path: '.factory/uploads/SPEC.md' }] };
const obligation = (id, refs, extra = {}) => ({ id, behavior: `Executable behavior for ${id}`, refs, sources: [{ path: '.factory/uploads/SPEC.md', locator: '§11' }], proof: { command: ['npm', 'test'], expect: 'passes' }, ...extra });
const v2Plan = () => ({ version: 2, jobId: 'job', requestId: 'request', contractDigest: 'frozen', compatibility: [], slices: [
  { id: 'BROWSE', title: 'Browse', objective: 'Complete browser controls', demo: 'Open the browser view', dependsOn: [], closes: ['MH-3'], acceptance: [obligation('BROWSE-1', ['MH-3'])] },
  { id: 'RESTART', title: 'Restart', objective: 'Verify durable workflow', demo: 'Restart and reopen', dependsOn: ['BROWSE'], closes: ['SC-2'], acceptance: [obligation('RESTART-1', ['SC-2'])] },
] });
test('v2 repair plans keep source references on every obligation', () => {
  const normalized = validateRecoveryPlan(v2Plan(), v2Request);
  assert.equal(normalized.requestId, 'request');
  assert.deepEqual(normalized.slices[0].acceptance[0].sources, [{ path: '.factory/uploads/SPEC.md', locator: '§11' }]);
});
for (const [name, mutate] of Object.entries({
  'uncited obligation': p => delete p.slices[0].acceptance[0].sources,
  'unknown source': p => p.slices[0].acceptance[0].sources[0].path = 'notes.md',
  'missing locator': p => p.slices[0].acceptance[0].sources[0].locator = '',
  'omitted gap': p => { p.slices.pop(); },
  'other request': p => p.requestId = 'other',
})) test(`rejects v2 repair plan with ${name}`, () => { const p = v2Plan(); mutate(p); assert.throws(() => validateRecoveryPlan(p, v2Request)); });
// Seen on a real Claude repair plan: the fix feature depended on a feature the original plan already built.
test('v2 repair plans may depend on already completed features but not on unknown ones', () => {
  const p = v2Plan(); p.slices[0].dependsOn = ['MONTHLY-SUMMARY'];
  assert.deepEqual(validateRecoveryPlan(p, { ...v2Request, completed: ['MONTHLY-SUMMARY'] }).slices[0].dependsOn, []);
  assert.throws(() => validateRecoveryPlan(p, v2Request), /unknown slice MONTHLY-SUMMARY/);
});

async function setup(t, mutate = async () => {}, { uploads = {}, alreadyPasses = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo-feature-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root); await store.init();
  // Supplied specs and prototype handoffs arrive at intake, before the run.
  for (const [name, body] of Object.entries(uploads)) { await mkdir(path.join(root, '.factory/uploads'), { recursive: true }); await writeFile(path.join(root, '.factory/uploads', name), body); }
  const job = await store.create({ brief: { workingName: 'Recovery fixture', mustHaves: ['Live saved searches', 'Edit people'], acceptanceScenarios: ['A new item enters its smart album'] }, transcript: [{ role: 'user', content: 'Recover the missing behavior' }, ...Object.keys(uploads).map(name => ({ role: 'user', content: `Attached file: .factory/uploads/${name}` }))], provider: 'fixture', sdlc: 'single' });
  const fixture = createFixtureProvider(); let recovering = false; let deployments = 0;
  const stages = []; const prompts = {};
  const factory = new SoloFactory({ store, maxRepairs: 1,
    commandRunner: async () => {
      // A repair plan targets real gaps, so a feature's checks fail until its builder has run.
      const cursor = (await store.read(job.id)).recoveryPhase?.cursor;
      if (!alreadyPasses && cursor?.substage === 'implementing' && !cursor.implementStarted) return { code: 1, output: `gap: ${cursor.id} is not built` };
      return { code: 0, output: 'fixture tests pass' };
    },
    deployer: async () => { deployments++; return { status: 'live', url: 'http://127.0.0.1:9991' }; },
    provider: { id: 'fixture', async run(args) {
      stages.push(args.context.stage); prompts[args.context.stage] = args.prompt;
      if (args.context.stage.startsWith('recovery-plan-')) recovering = true;
      const result = await fixture.run(args);
      if (args.context.stage === 'review' && !recovering) {
        const file = path.join(root, '.factory/review-result.json');
        const report = JSON.parse(await readFile(file, 'utf8'));
        report.verdict = 'blocked'; report.blockers = ['Missing feature']; report.checks[0].status = 'missing'; report.checks[2].status = 'unverified';
        await writeFile(file, JSON.stringify(report));
      }
      await mutate(args);
      return result;
    } },
  });
  const failed = await factory.start(job.id); assert.equal(failed.state, 'failed');
  return { root, store, factory, failed, stages, prompts, deployments: () => deployments };
}

test('plans, approves and executes same-run recovery, preserving contract and original evidence', async t => {
  const env = await setup(t); const before = await sourceBaseline(env.store);
  const oldFailure = await readFile(path.join(env.root, '.factory/last-failure-1.txt'), 'utf8');
  const ready = await env.factory.planRecovery(env.failed.id);
  assert.equal(ready.state, 'paused', ready.error?.message); assert.equal(ready.recoveryPhase.status, 'ready');
  assert.equal(await sourceBaseline(env.store), before); assert.equal(env.deployments(), 0);
  await assert.rejects(env.factory.resume(ready.id), /approve/);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(result.id, env.failed.id); assert.equal(result.sdlc, 'single');
  assert.equal(result.reviewContractDigest, env.failed.reviewContractDigest);
  assert.equal(result.recoveryPhase.done.length, 2); assert.equal(env.deployments(), 1);
  assert.equal(await readFile(path.join(env.root, '.factory/last-failure-1.txt'), 'utf8'), oldFailure);
  assert.ok(env.stages.at(-1) === 'review');
});

for (const changed of ['source', 'review', 'contract', 'plan', 'specs', 'reviewed plan']) test(`approval rejects changed ${changed}`, async t => {
  const env = await setup(t, undefined, { uploads: { 'SPEC.md': 'v1' } }); const ready = await env.factory.planRecovery(env.failed.id);
  const phase = ready.recoveryPhase;
  if (changed === 'source') await writeFile(path.join(env.root, 'new-source.js'), 'changed');
  if (changed === 'review') { const p = path.join(env.root, '.factory/review-result.json'); const r = JSON.parse(await readFile(p)); r.blockers.push('New finding'); await writeFile(p, JSON.stringify(r)); }
  if (changed === 'contract') await writeFile(path.join(env.root, '.factory/PRD.md'), 'Narrowed');
  if (changed === 'plan') phase.plan.slices[0].acceptance = ['Waived'];
  if (changed === 'specs') await writeFile(path.join(env.root, '.factory/uploads/SPEC.md'), 'v2: new scope');
  if (changed === 'reviewed plan') phase.planReview.planDigest = 'other';
  await assert.rejects(validateRecoveryApproval(env.factory, ready, phase.planDigest), /stale|match/);
  assert.equal(env.deployments(), 0);
});

test('planning that changes code is rejected without resetting or discarding it', async t => {
  const env = await setup(t, async args => { if (args.context.stage.startsWith('recovery-plan-')) await writeFile(path.join(args.cwd, 'unexpected.js'), 'unexpected change'); });
  const result = await env.factory.planRecovery(env.failed.id);
  assert.equal(result.state, 'failed'); assert.match(result.error.message, /planning turn changed/);
  assert.equal(result.recoveryPhase.status, 'plan_failed');
  assert.equal(await readFile(path.join(env.root, 'unexpected.js'), 'utf8'), 'unexpected change');
});

test('a failed repair-plan preparation continues only through one planning retry, never Resume', async t => {
  let first = true;
  const env = await setup(t, async args => { if (first && /^recovery-plan-(?!review)/.test(args.context.stage)) { first = false; await writeFile(path.join(args.cwd, 'unexpected.js'), 'unexpected change'); } });
  const failed = await env.factory.planRecovery(env.failed.id);
  assert.equal(failed.recoveryPhase.status, 'plan_failed');
  assert.equal(failed.recovery.canResume, false, 'new saves derive the banner from the continuation policy');
  // A banner saved before the policy existed still claims Resume; presentation derives, never rewrites it.
  const saved = await env.store.read(failed.id); saved.recovery = { ...saved.recovery, version: 2, canResume: true, actions: ['Review the recovery packet and the named log, then resume this run from its preserved files.'] };
  saved.recoveryPhase.corrections = 1; // the failed preparation spent its plan correction
  await env.store.writeState(saved);
  const raw = await readFile(path.join(env.store.jobDir(failed.id), 'state.json'), 'utf8');
  const next = continuationAction(saved);
  assert.deepEqual([next.action, next.label, next.endpoint], ['retry-plan', 'Retry repair-plan preparation', `/api/jobs/${failed.id}/recovery-plan`]);
  const shown = withContinuation(saved);
  assert.equal(shown.recovery.canResume, false); assert.equal(shown.nextAction.action, 'retry-plan');
  assert.ok(!shown.recovery.actions.some(text => /then resume this run/i.test(text)), shown.recovery.actions.join(' | '));
  assert.equal(await readFile(path.join(env.store.jobDir(failed.id), 'state.json'), 'utf8'), raw);
  assert.equal(continuationAction(saved, { busy: true }).action, 'none', 'an active writer never gets a duplicate launch');
  await assert.rejects(env.factory.resume(failed.id), error => error.code === 'recovery_approval_required' && /Retry repair-plan preparation/.test(error.message) && /\/recovery-plan/.test(error.message) && error.details.nextAction.action === 'retry-plan');
  const before = env.stages.length;
  const retried = await env.factory.planRecovery(failed.id);
  const ran = env.stages.slice(before);
  assert.equal(retried.recoveryPhase.status, 'ready', retried.error?.message);
  assert.equal(ran.filter(stage => /^recovery-plan-(?!review)/.test(stage)).length, 1, ran.join());
  assert.ok(ran.every(stage => /^recovery-(plan|correction)/.test(stage)), `only planning ran: ${ran.join()}`);
  assert.equal(retried.recoveryPhaseHistory.at(-1).status, 'plan_failed');
  assert.deepEqual(retried.recoveryPhase.request.checks, failed.recoveryPhase.request.checks);
  assert.equal(retried.attempt, failed.attempt); assert.equal(retried.repairBudgetLimit, failed.repairBudgetLimit);
  assert.equal(retried.recoveryPhase.corrections, 1, 'a planning retry does not renew plan corrections');
  assert.equal(env.deployments(), 0);
  assert.equal(continuationAction(retried).action, 'approve-plan');
  await assert.rejects(env.factory.resume(retried.id), /approve/);
});

test('a pause requested during a blocking repair-plan review stops before the correction turn', async t => {
  // Inbox follow-up: recovery planning turns ignored a pending Pause.
  let pause = true;
  const env = await setup(t, async args => {
    if (/^recovery-plan-review-/.test(args.context.stage) && pause) {
      pause = false;
      await env.factory.pause(env.failed.id);
      const file = path.join(args.cwd, '.factory/plan-review-result.json'); const r = JSON.parse(await readFile(file, 'utf8'));
      r.verdict = 'blocked'; r.blockers = ['SC-1 has no executable proof']; await writeFile(file, JSON.stringify(r));
    }
  });
  const parked = await env.factory.planRecovery(env.failed.id);
  assert.equal(parked.state, 'paused', parked.error?.message);
  assert.equal(parked.recoveryPhase.status, 'plan_failed');
  assert.equal(parked.recoveryPhase.corrections, 0, 'no correction budget spent');
  assert.equal(env.stages.filter(stage => /^recovery-correction-/.test(stage)).length, 0);
  assert.match(parked.recovery.summary, /Prepare the repair plan again/);
  assert.equal(continuationAction(parked).action, 'retry-plan');
  await assert.rejects(env.factory.resume(parked.id), /repair-plan preparation/i);
  const ready = await env.factory.planRecovery(parked.id);
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
});

test('a pause during the last blocked repair-plan review still fails exhausted, not retryable', async t => {
  // Codex review: the pause fired before phase.blocked was set, so a spent budget parked as a retryable plan_failed.
  let reviews = 0, env;
  env = await setup(t, async args => {
    if (/^recovery-plan-review-/.test(args.context.stage)) {
      reviews += 1;
      if (reviews === 2) await env.factory.pause(env.failed.id);
      const file = path.join(args.cwd, '.factory/plan-review-result.json'); const r = JSON.parse(await readFile(file, 'utf8'));
      r.verdict = 'blocked'; r.blockers = ['SC-1 has no executable proof']; await writeFile(file, JSON.stringify(r));
    }
  });
  const failed = await env.factory.planRecovery(env.failed.id);
  assert.equal(failed.state, 'failed', failed.error?.message);
  assert.equal(failed.error.code, 'plan_blocked');
  assert.equal(failed.recoveryPhase.blocked, true);
  assert.equal(continuationAction(failed).action, 'amend-plan');
});

test('a repair plan still blocked after its corrections offers a corrected-plan review, never a futile retry', async t => {
  let blocks = Infinity; // plan reviews still to block
  const env = await setup(t, async args => {
    if (/^recovery-plan-review-/.test(args.context.stage) && blocks > 0) {
      blocks -= 1;
      const file = path.join(args.cwd, '.factory/plan-review-result.json'); const r = JSON.parse(await readFile(file, 'utf8'));
      r.verdict = 'blocked'; r.blockers = ['SPEC.md §3 contradicts the frozen contract']; await writeFile(file, JSON.stringify(r));
    }
  }, { uploads: { 'SPEC.md': '§3 Group by upload day.\n' } });
  const failed = await env.factory.planRecovery(env.failed.id);
  assert.equal(failed.recoveryPhase.status, 'plan_failed'); assert.equal(failed.recoveryPhase.corrections, 1);
  assert.equal(failed.error.code, 'plan_blocked');
  const next = continuationAction(failed);
  assert.deepEqual([next.action, next.label, next.endpoint], ['amend-plan', 'Submit corrected plan for review', `/api/jobs/${failed.id}/recovery-review`]);
  assert.match(next.reason, /Automatic plan corrections are exhausted/);
  assert.equal(next.alternatives[0].action, 'revise-inputs');
  assert.deepEqual(failed.recoveryPhase.planBlockers, ['SPEC.md §3 contradicts the frozen contract']);
  assert.equal(failed.recovery.canResume, false);
  assert.ok(failed.recovery.actions.some(text => text.startsWith('Submit corrected plan for review')), failed.recovery.actions.join(' | '));
  assert.ok(!failed.recovery.actions.some(text => /retry repair-plan preparation/i.test(text)), failed.recovery.actions.join(' | '));
  // A run saved before the error code existed is recognized by its message.
  assert.equal(continuationAction({ ...failed, error: { ...failed.error, code: 'unexpected_error' } }).action, 'amend-plan');
  // Unchanged inputs: refused before any turn, nothing written.
  const raw = await readFile(path.join(env.store.jobDir(failed.id), 'state.json'), 'utf8'); const before = env.stages.length;
  await assert.rejects(env.factory.planRecovery(failed.id), error => error.code === 'plan_inputs_unchanged' && /Submit corrected plan for review/.test(error.message) && error.details.nextAction.action === 'amend-plan');
  assert.equal(env.stages.length, before);
  assert.equal(await readFile(path.join(env.store.jobDir(failed.id), 'state.json'), 'utf8'), raw);
  await assert.rejects(env.factory.resume(failed.id), /Submit corrected plan/);
  // Revised inputs make a new plan with a fresh correction budget.
  await writeFile(path.join(env.root, '.factory/uploads/SPEC.md'), '§3 Group by capture day, as the contract says.\n'); blocks = 0;
  const ready = await env.factory.planRecovery(failed.id);
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
  assert.equal(ready.recoveryPhase.corrections, 0);
  assert.deepEqual(ready.recoveryPhase.request.inputsChanged, ['.factory/uploads/SPEC.md']);
  assert.equal(ready.recoveryPhaseHistory.at(-1).status, 'plan_failed');
  // The fresh budget belongs to the revised fingerprint: every later preparation against it shares it.
  const corrections = () => env.stages.filter(stage => /^recovery-correction-/.test(stage)).length;
  blocks = 1; let spent = corrections();
  const revisedOnce = await env.factory.planRecovery(failed.id, 'Name the capture-day test');
  assert.equal(revisedOnce.recoveryPhase.status, 'ready', revisedOnce.error?.message);
  assert.equal(corrections() - spent, 1); assert.equal(revisedOnce.recoveryPhase.corrections, 1);
  blocks = Infinity; spent = corrections();
  const spentOut = await env.factory.planRecovery(failed.id, 'Again');
  assert.equal(spentOut.recoveryPhase.status, 'plan_failed'); assert.equal(spentOut.error.code, 'plan_blocked');
  assert.equal(corrections() - spent, 0, 'feedback on a ready plan does not renew its fingerprint budget');
  // Returning to the first inputs, whose budget is exhausted, is refused before any planner or reviewer turn.
  await writeFile(path.join(env.root, '.factory/uploads/SPEC.md'), '§3 Group by upload day.\n');
  const turns = env.stages.length; const saved = await readFile(path.join(env.store.jobDir(failed.id), 'state.json'), 'utf8');
  await assert.rejects(env.factory.planRecovery(failed.id), error => error.code === 'plan_inputs_unchanged'
    && error.message.startsWith('These inputs have exhausted their plan corrections.')
    && error.details.nextAction.action === 'amend-plan' && error.details.blockers[0] === 'SPEC.md §3 contradicts the frozen contract');
  assert.equal(env.stages.length, turns, 'no planner or reviewer turn ran');
  assert.equal(await readFile(path.join(env.store.jobDir(failed.id), 'state.json'), 'utf8'), saved);
  assert.equal(env.deployments(), 0);
});

test('all features pass but the final review fails: Resume is refused and a repair plan is offered', async t => {
  let planned = false;
  const env = await setup(t, async args => {
    if (args.context.stage.startsWith('recovery-plan-')) planned = true;
    if (args.context.stage === 'review' && planned) {
      const p = path.join(args.cwd, '.factory/review-result.json'); const r = JSON.parse(await readFile(p));
      r.verdict = 'blocked'; r.checks[1].status = 'missing'; r.blockers = ['Existing behavior regressed']; await writeFile(p, JSON.stringify(r));
    }
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'failed'); assert.equal(env.deployments(), 0);
  assert.equal(result.recoveryPhase.status, 'built'); assert.equal(result.recoveryPhase.done.length, 2);
  assert.equal(result.attempt, 2, 'unused earlier feature budgets cannot inflate final integration repairs');
  assert.equal(result.recovery.canResume, false); assert.match(result.recovery.actions[0], /^Prepare repair plan/);
  const reviews = env.stages.filter(s => s === 'review').length;
  await assert.rejects(env.factory.resume(result.id), /Prepare a repair plan/);
  const parked = await env.store.read(result.id);
  assert.equal(parked.attempt, 2); assert.equal(parked.repairBudgetLimit, result.repairBudgetLimit);
  assert.equal(env.stages.filter(s => s === 'review').length, reviews, 'no futile review');
  const next = await env.factory.planRecovery(result.id);
  assert.equal(next.recoveryPhase.status, 'ready', next.error?.message);
  assert.deepEqual(next.recoveryPhase.request.checks.map(c => c.id), ['MH-2']);
  assert.equal(next.recoveryPhaseHistory.at(-1).done.length, 2, 'completed features and the prior plan are preserved');
});

for (const corrected of [false, true]) test(`repair plans omitting detailed supplied requirements ${corrected ? 'are corrected before' : 'block before any'} build`, async t => {
  // Every MH/SC tag is closed, but the supplied spec's detailed obligations are not cited.
  const env = await setup(t, async args => {
    const phase = args.context.job.recoveryPhase;
    if (corrected && /^recovery-correction-/.test(args.context.stage)) {
      const file = path.join(args.cwd, phase.planFile); const p = JSON.parse(await readFile(file, 'utf8'));
      p.slices[0].acceptance.push({ id: 'EXIF-1', behavior: 'Calendar-day grouping honors EXIF offsets', refs: [p.slices[0].closes[0]], sources: [{ path: '.factory/uploads/SPEC.md', locator: '§3 EXIF offsets' }], proof: { command: ['npm', 'test'], expect: 'exif offsets test passes' } });
      await writeFile(file, JSON.stringify(p));
    }
    if (/^recovery-plan-review-/.test(args.context.stage)) {
      const p = JSON.parse(await readFile(path.join(args.cwd, phase.planFile), 'utf8'));
      const cited = p.slices.some(slice => slice.acceptance.some(item => item.sources?.some(ref => ref.path === '.factory/uploads/SPEC.md' && /EXIF offsets/.test(ref.locator))));
      if (!cited) {
        const file = path.join(args.cwd, '.factory/plan-review-result.json'); const r = JSON.parse(await readFile(file, 'utf8'));
        r.verdict = 'blocked'; r.blockers = ['SPEC.md §3 EXIF offsets/calendar-day semantics have no obligation']; await writeFile(file, JSON.stringify(r));
      }
    }
  }, { uploads: { 'SPEC.md': '§3 EXIF offsets: group by calendar day in the capture offset.\n§4 All EXIF filters and compound examples.\n' } });
  const result = await env.factory.planRecovery(env.failed.id);
  assert.ok(result.recoveryPhase.request.sources.some(ref => ref.path === '.factory/uploads/SPEC.md'));
  if (corrected) {
    assert.equal(result.recoveryPhase.status, 'ready', result.error?.message);
    assert.ok(result.recoveryPhase.plan.slices[0].acceptance.some(item => item.id === 'EXIF-1'));
  } else {
    assert.equal(result.state, 'failed'); assert.equal(result.recoveryPhase.status, 'plan_failed');
    assert.match(result.error.message, /still blocked.*EXIF offsets/);
    assert.equal(env.stages.filter(s => /^recovery-correction-/.test(s)).length, 1);
    await assert.rejects(validateRecoveryApproval(env.factory, result, result.recoveryPhase.planDigest), /match/);
  }
  assert.equal(env.stages.filter(s => /-RECOVERY-\d+$/.test(s)).length, 0, 'no repair build before an approved plan');
  assert.equal(env.deployments(), 0);
});

test('interrupted recovery resumes unfinished feature and does not replay verified work', async t => {
  let interrupt = true;
  const env = await setup(t, async args => {
    if (/^recovery-.*-RECOVERY-2$/.test(args.context.stage) && interrupt) { interrupt = false; throw new Error('Interrupted feature'); }
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  const failed = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(failed.state, 'failed'); assert.deepEqual(failed.recoveryPhase.done, ['RECOVERY-1']);
  const result = await env.factory.resume(failed.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-1$/.test(s)).length, 1);
  assert.equal(result.recoveryPhase.done.length, 2);
});

test('feature repair exhaustion parks with durable budget and no deployment', async t => {
  const env = await setup(t, async args => {
    if (/^recovery-(?!plan-).*-review-\d+$/.test(args.context.stage)) {
      const p = path.join(args.cwd, '.factory/review-result.json'); const r = JSON.parse(await readFile(p)); r.verdict = 'blocked'; r.checks[0].status = 'missing'; r.blockers = ['Feature still missing']; await writeFile(p, JSON.stringify(r));
    }
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  const failed = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(failed.state, 'failed'); assert.equal(failed.attempt, 2); assert.equal(failed.repairBudgetLimit, 2);
  await assert.rejects(env.factory.resume(failed.id), /Prepare a repair plan/);
  const parked = await env.store.read(failed.id);
  assert.equal(parked.attempt, 2); assert.equal(parked.repairBudgetLimit, 2);
  const next = await env.factory.planRecovery(failed.id);
  assert.equal(next.recoveryPhase.status, 'ready', next.error?.message);
  assert.deepEqual(next.recoveryPhase.request.checks, failed.recoveryPhase.request.checks, 'gaps are the prior plan\'s unclosed checks');
  assert.equal(env.deployments(), 0);
});

test('plan revision carries feedback and prior candidate, invalidating earlier approval', async t => {
  const env = await setup(t);
  const first = await env.factory.planRecovery(env.failed.id);
  const revised = await env.factory.planRecovery(first.id, 'Move workers before metadata and model integration checks.');
  assert.equal(revised.recoveryPhase.status, 'ready', revised.error?.message);
  assert.match(revised.recoveryPhase.request.guidance, /workers before metadata/);
  assert.equal(digest(revised.recoveryPhase.request.priorPlan), first.recoveryPhase.planDigest);
  assert.equal(revised.recoveryPhaseHistory.length, 1);
  await assert.rejects(validateRecoveryApproval(env.factory, revised, first.recoveryPhase.planDigest), /match/);
});

test('prerequisite-only features can precede the owners of full original checks', () => {
  const p = plan(); p.slices.unshift({ id: 'FOUNDATION', title: 'Worker foundation', objective: 'Provide durable job execution', checks: [], acceptance: ['Execute worker lease and retry tests'], dependsOn: [] });
  p.slices[1].dependsOn = ['FOUNDATION'];
  const normalized = validateRecoveryPlan(p, request);
  assert.deepEqual(normalized.slices[0].checks, []);
  assert.equal(normalized.slices.length, 3);
});

// Recovery features share the planned-feature safeguards (candidate binding, strict checkpoint, input lock, substage cursor).
test('a recovery reviewer that edits the candidate voids its verdict and forces a fresh review', async t => {
  let edited = false;
  const env = await setup(t, async args => {
    if (!edited && /^recovery-.*-RECOVERY-1-review-1$/.test(args.context.stage)) { edited = true; await writeFile(path.join(args.cwd, 'reviewer-edit.js'), 'export const x = 1;\n'); }
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-1-review-\d+$/.test(s)).length, 2);
  assert.equal(result.recoveryPhase.stats['RECOVERY-1'].reviews, 2);
  const events = await env.store.events(result.id, 1000);
  assert.ok(events.some(e => e.type === 'gate.failed' && /verdict is void/.test(e.message)));
});

test('a failed recovery checkpoint does not advance the feature or deploy', async t => {
  const env = await setup(t);
  const commit = env.store.commit.bind(env.store);
  env.store.commit = async message => { if (message === 'factory: feature RECOVERY-1 verified') throw new Error('disk full'); return commit(message); };
  const ready = await env.factory.planRecovery(env.failed.id);
  const failed = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'checkpoint_failed');
  assert.deepEqual(failed.recoveryPhase.done, []); assert.equal(failed.recoveryPhase.cursor.substage, 'committing');
  assert.equal(env.deployments(), 0);
  env.store.commit = commit;
  const result = await env.factory.resume(failed.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-1-review-\d+$/.test(s)).length, 1, 'the reviewed candidate is not reviewed again');
});

test('a supplied input edited after repair-plan approval stops recovery before the next feature and never deploys', async t => {
  const env = await setup(t, async args => {
    if (/^recovery-.*-RECOVERY-1-review-1$/.test(args.context.stage)) await writeFile(path.join(args.cwd, '.factory/uploads/SPEC.md'), 'v2: new scope');
  }, { uploads: { 'SPEC.md': 'v1' } });
  const ready = await env.factory.planRecovery(env.failed.id);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'inputs_changed');
  assert.ok(!result.recoveryPhase.done.includes('RECOVERY-2'));
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-2$/.test(s)).length, 0);
  assert.equal(env.deployments(), 0);
});

test('a malformed repair plan is fixed on the schema budget without spending a correction', async t => {
  let valid;
  const env = await setup(t, async args => {
    const file = path.join(args.cwd, `.factory/recovery-plan-${args.context.job.recoveryPhase?.id}.json`);
    if (/^recovery-plan-(?!review)/.test(args.context.stage)) { valid = await readFile(file, 'utf8'); await writeFile(file, '{}'); }
    if (/^recovery-schema-fix-/.test(args.context.stage)) await writeFile(file, valid);
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
  assert.equal(ready.recoveryPhase.corrections, 0);
  assert.equal(env.stages.filter(s => /^recovery-schema-fix-/.test(s)).length, 1);
});

test('a pause pending when a recovery feature fails its checks parks before the repair turn, budget untouched', async t => {
  // Live run 4f2dd1cf: a proof failed under a pending Pause and repair-17 still started.
  const env = await setup(t);
  const ready = await env.factory.planRecovery(env.failed.id);
  const repairs = () => env.stages.filter(s => /^repair-/.test(s)).length, before = repairs();
  let failed = false;
  const run = env.factory.commandRunner;
  env.factory.commandRunner = async opts => {
    const cursor = (await env.store.read(ready.id)).recoveryPhase.cursor;
    if (!failed && cursor?.substage === 'checking') { failed = true; await env.factory.pause(ready.id); return { code: 1, output: 'proof failed' }; }
    return run(opts);
  };
  const parked = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(parked.state, 'paused', parked.error?.message);
  assert.equal(parked.recoveryPhase.cursor.substage, 'checking');
  assert.equal(parked.attempt, ready.attempt, 'no repair budget spent');
  assert.equal(repairs(), before, 'no repair turn');
  const result = await env.factory.resume(parked.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(repairs(), before);
});

test('a recovery pause after checks resumes at review without re-implementing', async t => {
  const env = await setup(t);
  const ready = await env.factory.planRecovery(env.failed.id);
  let paused = false;
  const run = env.factory.commandRunner;
  env.factory.commandRunner = async opts => {
    if (!paused && (await env.store.read(ready.id)).recoveryPhase.cursor?.implementStarted) { paused = true; await env.factory.pause(ready.id); }
    return run(opts);
  };
  const parked = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(parked.state, 'paused', parked.error?.message);
  assert.equal(parked.recoveryPhase.cursor.id, 'RECOVERY-1'); assert.equal(parked.recoveryPhase.cursor.substage, 'reviewing');
  const result = await env.factory.resume(parked.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-1(-resume)?$/.test(s)).length, 1, 'implementation ran once');
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-1-review-\d+$/.test(s)).length, 1);
});

test('a legacy recovery phase parked mid-feature (no cursor) resumes with its budget and rechecks instead of rebuilding', async t => {
  let interrupt = true; const limits = [];
  const env = await setup(t, async args => {
    if (/^recovery-.*-RECOVERY-1-review-\d+$/.test(args.context.stage)) limits.push(args.context.job.repairBudgetLimit);
    if (interrupt && /^recovery-.*-RECOVERY-1-review-1$/.test(args.context.stage)) { interrupt = false; throw new Error('Interrupted during review'); }
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  const parked = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(parked.state, 'failed');
  // Rewrite to the pre-cursor shape: legacy phases only recorded current/index.
  const legacy = await env.store.read(parked.id);
  delete legacy.recoveryPhase.cursor; legacy.recoveryPhase.current = 'RECOVERY-1';
  await env.store.writeState(legacy);
  const builds = env.stages.filter(s => /^recovery-.*-RECOVERY-1(-resume)?$/.test(s)).length;
  const result = await env.factory.resume(parked.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-1(-resume)?$/.test(s)).length, builds, 'no rebuild of the parked feature');
  assert.ok(limits.length >= 2, 'the preserved work was reviewed again');
  assert.equal(limits.at(-1), parked.repairBudgetLimit, 'the parked feature keeps its repair budget');
  assert.ok(result.recoveryPhase.stats['RECOVERY-1'], 'the migrated feature completed');
  assert.equal(result.recoveryPhase.done.length, 2);
});

const builds = env => env.stages.filter(s => /^recovery-(?!plan-|correction-).*-RECOVERY-\d+(-resume)?$/.test(s));
test('a repair feature whose checks already pass skips its build turn but keeps its scoped review', async t => {
  const env = await setup(t, async () => {}, { alreadyPasses: true });
  const ready = await env.factory.planRecovery(env.failed.id);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.deepEqual(builds(env), [], 'no builder turn for behavior that already passes');
  assert.equal(env.stages.filter(s => /^recovery-.*-RECOVERY-\d+-review-\d+$/.test(s)).length, 2, 'each feature is still reviewed');
  assert.equal(result.attempt, ready.attempt, 'checking first spends no repair budget');
  const events = await env.store.events(result.id, 1000);
  assert.equal(events.filter(e => e.type === 'feature.preverified').length, 2);
});

test('a repair feature whose checks fail before building hands that failure to its builder, spending no repair', async t => {
  const env = await setup(t);
  const ready = await env.factory.planRecovery(env.failed.id);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(builds(env).length, 2);
  const prompt = env.prompts[builds(env)[0]];
  const file = prompt.match(/\.factory\/precheck-RECOVERY-1\.txt/)?.[0];
  assert.ok(file, 'the builder is pointed at the pre-build failure');
  assert.match(await readFile(path.join(env.root, file), 'utf8'), /gap: RECOVERY-1 is not built/);
  assert.equal(result.attempt, ready.attempt);
});

test('a repair feature precheck that times out parks before its builder; resume reruns the precheck', async t => {
  // Codex review: a timed-out precheck was recorded as the builder's failure and the build turn started.
  const env = await setup(t);
  const ready = await env.factory.planRecovery(env.failed.id);
  let timedOut = false;
  const run = env.factory.commandRunner;
  env.factory.commandRunner = async opts => {
    const cursor = (await env.store.read(ready.id)).recoveryPhase.cursor;
    if (!timedOut && cursor?.substage === 'implementing' && !cursor.implementStarted) { timedOut = true; return { code: null, timedOut: true, timeoutReason: 'hard', output: 'Interrupted while running' }; }
    return run(opts);
  };
  const parked = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(parked.error?.code, 'gate_timeout', JSON.stringify(parked.error));
  assert.deepEqual(builds(env), [], 'no builder turn after a timed-out precheck');
  assert.ok(!parked.recoveryPhase.cursor.prechecked);
  const result = await env.factory.resume(parked.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.match(await readFile(path.join(env.root, '.factory/precheck-RECOVERY-1.txt'), 'utf8'), /gap: RECOVERY-1 is not built/);
});

test('a pre-verified repair feature that its reviewer blocks goes to its builder, not a repair turn', async t => {
  let blocked = false;
  const env = await setup(t, async args => {
    if (!blocked && /^recovery-.*-RECOVERY-1-review-1$/.test(args.context.stage)) {
      blocked = true;
      const p = path.join(args.cwd, '.factory/review-result.json'); const r = JSON.parse(await readFile(p)); r.verdict = 'blocked'; r.checks[0].status = 'missing'; r.blockers = ['Tests pass but the browser control is absent']; await writeFile(p, JSON.stringify(r));
    }
  }, { alreadyPasses: true });
  const ready = await env.factory.planRecovery(env.failed.id);
  const result = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(builds(env).length, 1); assert.match(builds(env)[0], /-RECOVERY-1$/);
  assert.match(env.prompts[builds(env)[0]], /precheck-RECOVERY-1\.txt/);
  assert.match(await readFile(path.join(env.root, '.factory/precheck-RECOVERY-1.txt'), 'utf8'), /browser control is absent/);
  assert.equal(result.attempt, ready.attempt, 'no repair turn was spent');
});

test('an approved batch parks after its features with cursor and budget kept; resume can approve another batch', async t => {
  const env = await setup(t);
  const ready = await env.factory.planRecovery(env.failed.id);
  await assert.rejects(env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest, { features: 0 }), /positive whole number/);
  assert.equal((await env.store.read(ready.id)).recoveryPhase.status, 'ready', 'a bad batch size changes nothing');
  const parked = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest, { features: 1 });
  assert.equal(parked.state, 'paused', parked.error?.message);
  assert.deepEqual(parked.recoveryPhase.done, ['RECOVERY-1']); assert.equal(parked.recoveryPhase.status, 'running');
  assert.equal(parked.recoveryPhase.batchEnd, null);
  assert.equal(builds(env).length, 1, 'the next feature did not start'); assert.equal(env.deployments(), 0);
  assert.equal(continuationAction(parked, { maxRepairs: 1 }).action, 'resume');
  const events = await env.store.events(parked.id, 1000);
  assert.match(events.findLast(e => e.type === 'job.paused').message, /building/);
  const result = await env.factory.resume(parked.id, { features: 5 });
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(builds(env).length, 2, 'the verified feature was not rebuilt');
  assert.equal(result.repairBudgetLimit <= parked.recoveryPhase.totalRepairLimit, true);
});

test('a pending proof from an earlier recovery phase still gates completion after a later repair plan', async t => {
  let planned = 0; const proof = { code: 1 };
  const env = await setup(t, async args => {
    const phase = args.context.job.recoveryPhase;
    if (/^recovery-plan-(?!review)/.test(args.context.stage)) {
      planned++;
      if (planned === 1) { const file = path.join(args.cwd, phase.planFile); const p = JSON.parse(await readFile(file, 'utf8'));
        p.slices[0].acceptance.push({ id: 'LATE-1', behavior: 'Populated smart album renders after every feature exists', refs: p.slices[0].closes, sources: p.slices[0].acceptance[0].sources, proof: { command: ['node', '--test', 'test/late.test.mjs'], expect: 'passes', pending: 'integration' } });
        await writeFile(file, JSON.stringify(p)); }
    }
    if (args.context.stage === 'review' && planned === 1) {
      const p = path.join(args.cwd, '.factory/review-result.json'); const r = JSON.parse(await readFile(p));
      r.verdict = 'blocked'; r.checks[1].status = 'missing'; r.blockers = ['Existing behavior regressed']; await writeFile(p, JSON.stringify(r));
    }
  });
  env.factory.commandRunner = async ({ args }) => ({ code: args.includes('test/late.test.mjs') ? proof.code : 0, output: 'late output' });
  const first = await env.factory.planRecovery(env.failed.id);
  // The pending proof must not stop the first phase before its review; the review failure drives the second plan.
  proof.code = 0;
  const blocked = await env.factory.startRecovery(first.id, first.recoveryPhase.planDigest);
  assert.equal(blocked.error?.code, 'review_rejected', blocked.error?.message);
  assert.equal(blocked.outstandingProofs.filter(e => e.status === 'pending').length, 1);
  proof.code = 1;
  const second = await env.factory.planRecovery(blocked.id);
  assert.equal(second.recoveryPhase.status, 'ready', second.error?.message);
  const result = await env.factory.startRecovery(second.id, second.recoveryPhase.planDigest);
  assert.equal(result.state, 'failed', 'the earlier phase\'s pending proof still runs and fails');
  assert.match(result.error.details?.gate ?? '', /LATE-1$/);
  assert.equal(env.deployments(), 0);
});
