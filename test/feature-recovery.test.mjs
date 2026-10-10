import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/store.mjs';
import { SoloFactory } from '../src/factory.mjs';
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

async function setup(t, mutate = async () => {}, { uploads = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo-feature-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root); await store.init();
  // Supplied specs and prototype handoffs arrive at intake, before the run.
  for (const [name, body] of Object.entries(uploads)) { await mkdir(path.join(root, '.factory/uploads'), { recursive: true }); await writeFile(path.join(root, '.factory/uploads', name), body); }
  const job = await store.create({ brief: { workingName: 'Recovery fixture', mustHaves: ['Live saved searches', 'Edit people'], acceptanceScenarios: ['A new item enters its smart album'] }, transcript: [{ role: 'user', content: 'Recover the missing behavior' }, ...Object.keys(uploads).map(name => ({ role: 'user', content: `Attached file: .factory/uploads/${name}` }))], provider: 'fixture', sdlc: 'single' });
  const fixture = createFixtureProvider(); let recovering = false; let deployments = 0;
  const stages = [];
  const factory = new SoloFactory({ store, maxRepairs: 1,
    commandRunner: async () => ({ code: 0, output: 'fixture tests pass' }),
    deployer: async () => { deployments++; return { status: 'live', url: 'http://127.0.0.1:9991' }; },
    provider: { id: 'fixture', async run(args) {
      stages.push(args.context.stage);
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
  return { root, store, factory, failed, stages, deployments: () => deployments };
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

test('a recovery pause after checks resumes at review without re-implementing', async t => {
  const env = await setup(t);
  const ready = await env.factory.planRecovery(env.failed.id);
  let paused = false;
  const run = env.factory.commandRunner;
  env.factory.commandRunner = async opts => {
    if (!paused) { paused = true; await env.factory.pause(ready.id); }
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
