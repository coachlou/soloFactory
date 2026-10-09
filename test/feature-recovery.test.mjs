import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

async function setup(t, mutate = async () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo-feature-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root); await store.init();
  const job = await store.create({ brief: { workingName: 'Recovery fixture', mustHaves: ['Live saved searches', 'Edit people'], acceptanceScenarios: ['A new item enters its smart album'] }, transcript: [{ role: 'user', content: 'Recover the missing behavior' }], provider: 'fixture', sdlc: 'single' });
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

for (const changed of ['source', 'review', 'contract', 'plan']) test(`approval rejects changed ${changed}`, async t => {
  const env = await setup(t); const ready = await env.factory.planRecovery(env.failed.id);
  const phase = ready.recoveryPhase;
  if (changed === 'source') await writeFile(path.join(env.root, 'new-source.js'), 'changed');
  if (changed === 'review') { const p = path.join(env.root, '.factory/review-result.json'); const r = JSON.parse(await readFile(p)); r.blockers.push('New finding'); await writeFile(p, JSON.stringify(r)); }
  if (changed === 'contract') await writeFile(path.join(env.root, '.factory/PRD.md'), 'Narrowed');
  if (changed === 'plan') phase.plan.slices[0].acceptance = ['Waived'];
  await assert.rejects(validateRecoveryApproval(env.factory, ready, phase.planDigest), /stale|match/);
  assert.equal(env.deployments(), 0);
});

test('planning that changes code is rejected without resetting or discarding it', async t => {
  const env = await setup(t, async args => { if (args.context.stage.startsWith('recovery-plan-')) await writeFile(path.join(args.cwd, 'unexpected.js'), 'unexpected change'); });
  const result = await env.factory.planRecovery(env.failed.id);
  assert.equal(result.state, 'failed'); assert.match(result.error.message, /Planning changed/);
  assert.equal(result.recoveryPhase.status, 'plan_failed');
  assert.equal(await readFile(path.join(env.root, 'unexpected.js'), 'utf8'), 'unexpected change');
});

test('scoped feature reviews cannot bypass the original final contract review', async t => {
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
  assert.equal(result.state, 'failed'); assert.equal(env.deployments(), 0); assert.equal(result.recoveryPhase.done.length, 2);
  assert.equal(result.attempt, 2, 'unused earlier feature budgets cannot inflate final integration repairs');
  const resumed = await env.factory.resume(result.id);
  assert.equal(resumed.state, 'failed'); assert.equal(resumed.attempt, 2, 'resume cannot renew the integration budget');
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
    if (/^recovery-.*-review-\d+$/.test(args.context.stage)) {
      const p = path.join(args.cwd, '.factory/review-result.json'); const r = JSON.parse(await readFile(p)); r.verdict = 'blocked'; r.checks[0].status = 'missing'; r.blockers = ['Feature still missing']; await writeFile(p, JSON.stringify(r));
    }
  });
  const ready = await env.factory.planRecovery(env.failed.id);
  const failed = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(failed.state, 'failed'); assert.equal(failed.attempt, 2); assert.equal(failed.repairBudgetLimit, 2);
  const resumed = await env.factory.resume(failed.id);
  assert.equal(resumed.state, 'failed'); assert.equal(resumed.attempt, 2); assert.equal(resumed.repairBudgetLimit, 2);
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
