import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/store.mjs';
import { SoloFactory, continuationAction, withContinuation } from '../src/factory.mjs';
import { createFixtureProvider } from '../src/fixture-provider.mjs';
import { createSoloFactoryServer } from '../src/server.mjs';
import { prepareReview } from '../src/review.mjs';
import { buildRecovery } from '../src/factory.mjs';
import { digest, planKey, validateRecoveryApproval, validateRecoveryPlan } from '../src/feature-recovery.mjs';

// Exhausted plan corrections with an independent reviewer that still blocks: the owner submits a corrected
// plan for exactly one review (no planner, no correction budget), then approves the exact reviewed plan.
const BLOCKERS = ['SPEC.md §3 obligations are missing from the plan'];
const planner = stage => /^recovery-plan-(?!review)/.test(stage);
const reviewer = stage => /^recovery-plan-review-/.test(stage);

async function setup(t, { malformed = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo-plan-amendment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root); await store.init();
  await mkdir(path.join(root, '.factory/uploads'), { recursive: true });
  await writeFile(path.join(root, '.factory/uploads/SPEC.md'), '§3 Group by capture day.\n');
  const job = await store.create({ brief: { workingName: 'Amendment fixture', mustHaves: ['Live saved searches', 'Edit people'], acceptanceScenarios: ['A new item enters its smart album'] }, transcript: [{ role: 'user', content: 'Recover the missing behavior' }, { role: 'user', content: 'Attached file: .factory/uploads/SPEC.md' }], provider: 'fixture', sdlc: 'single' });
  const fixture = createFixtureProvider(); let recovering = false; let deployments = 0;
  const stages = []; const requests = [];
  const ctl = { block: true, modify: false, fail: false };
  const opts = { store, maxRepairs: 1,
    commandRunner: async () => ({ code: 0, output: 'fixture tests pass' }),
    deployer: async () => { deployments++; return { status: 'live', url: 'http://127.0.0.1:9991' }; },
    provider: { id: 'fixture', async run(args) {
      stages.push(args.context.stage);
      if (planner(args.context.stage)) recovering = true;
      const result = await fixture.run(args);
      if (args.context.stage === 'review' && !recovering) {
        const file = path.join(root, '.factory/review-result.json');
        const report = JSON.parse(await readFile(file, 'utf8'));
        report.verdict = 'blocked'; report.blockers = ['Missing feature']; report.checks[0].status = 'missing'; report.checks[2].status = 'unverified';
        await writeFile(file, JSON.stringify(report));
      }
      if (malformed && /^recovery-(plan|correction)-(?!review)/.test(args.context.stage)) await writeFile(path.join(args.cwd, args.context.job.recoveryPhase.planFile), 'not json {');
      if (reviewer(args.context.stage)) {
        requests.push(JSON.parse(await readFile(path.join(args.cwd, '.factory/plan-review-request.json'), 'utf8')));
        if (ctl.fail) { ctl.fail = false; throw new Error('provider interrupted'); }
        if (ctl.modify) { const file = path.join(args.cwd, args.context.job.recoveryPhase.planFile); const p = JSON.parse(await readFile(file, 'utf8')); p.slices[0].title += ' (edited by reviewer)'; await writeFile(file, JSON.stringify(p)); }
        if (ctl.block) {
          const file = path.join(args.cwd, '.factory/plan-review-result.json'); const r = JSON.parse(await readFile(file, 'utf8'));
          r.verdict = 'blocked'; r.blockers = BLOCKERS; await writeFile(file, JSON.stringify(r));
        }
      }
      return result;
    } },
  };
  const factory = new SoloFactory(opts);
  const failed = await factory.start(job.id); assert.equal(failed.state, 'failed');
  const blocked = await factory.planRecovery(failed.id);
  assert.equal(blocked.recoveryPhase.status, 'plan_failed'); assert.equal(blocked.error.code, 'plan_blocked');
  assert.equal(blocked.recoveryPhase.blocked, true);
  const state = () => readFile(path.join(store.jobDir(job.id), 'state.json'), 'utf8');
  return { root, store, factory, opts, ctl, blocked, stages, requests, state, deployments: () => deployments };
}

// A structurally valid corrected plan for the request. `n` makes distinct candidates.
const candidate = (job, n = 1) => {
  const r = job.recoveryPhase.request;
  return { version: 2, jobId: r.jobId, requestId: r.id, contractDigest: r.contractDigest, compatibility: [],
    slices: r.checks.map((c, i) => ({ id: `AMEND-${i + 1}`, title: `${c.text} v${n}`, objective: `Recover ${c.id}`, closes: [c.id], demo: 'Run the executable fixture behavior checks.', dependsOn: i ? [`AMEND-${i}`] : [],
      acceptance: [{ id: `AMEND-${i + 1}-1`, behavior: `Executes server.test.mjs to verify ${c.text} (${n})`, refs: [c.id], sources: [{ path: r.sources[0].path, locator: `${c.id} §3` }], proof: { command: ['npm', 'test'], expect: 'server.test.mjs passes' } }] })) };
};
const submit = (env, plan, job = env.blocked) => env.factory.amendRecovery(job.id, { phaseId: job.recoveryPhase.id, plan });
const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reverse(value[k])])) : value;
const refused = async (env, run, code, status) => {
  run.catch(() => {}); // handled here; the assertion below reads the rejection
  const raw = await env.state(); const turns = env.stages.length;
  await assert.rejects(run, error => error.code === code && (status === undefined || error.details?.status === status), `expected ${code}`);
  assert.equal(env.stages.length, turns, 'a rejected submission starts zero provider turns');
  assert.equal(await env.state(), raw, 'a rejected submission leaves saved state byte-for-byte unchanged');
};

test('exhausted corrections explain a plan problem and offer a corrected-plan review, not a specs change', async t => {
  const env = await setup(t);
  const next = continuationAction(env.blocked);
  assert.deepEqual([next.action, next.label, next.endpoint], ['amend-plan', 'Submit corrected plan for review', `/api/jobs/${env.blocked.id}/recovery-review`]);
  assert.equal(next.reason, 'Automatic plan corrections are exhausted. The plan still has review blockers. Correct the plan and submit it for review. Change the requirements only if the inputs themselves are wrong.');
  assert.deepEqual(next.alternatives.map(item => [item.action, item.endpoint]), [['revise-inputs', `/api/jobs/${env.blocked.id}/recovery-plan`]]);
  const shown = withContinuation(env.blocked);
  assert.equal(shown.recovery.canResume, false);
  assert.ok(shown.recovery.actions.some(text => text.startsWith('Submit corrected plan for review')), shown.recovery.actions.join(' | '));
  assert.ok(!shown.recovery.actions.some(text => /^Revise inputs and prepare a new plan:/.test(text) && /cannot pass review/.test(text)));
  assert.doesNotMatch(JSON.stringify(shown.recovery), /specs must change/i);
  await assert.rejects(env.factory.resume(env.blocked.id), error => error.code === 'repair_plan_required' && /Submit corrected plan for review/.test(error.message));
  // Ordinary retry stays refused before any turn and now points at the amendment.
  await refused(env, env.factory.planRecovery(env.blocked.id), 'plan_inputs_unchanged');
  await assert.rejects(env.factory.planRecovery(env.blocked.id), error => error.details.nextAction.action === 'amend-plan' && error.details.blockers[0] === BLOCKERS[0]);
});

test('a passing amendment starts one reviewer, no planner or correction, keeps the budget, and needs exact approval', async t => {
  const env = await setup(t);
  const oldPlanFile = path.join(env.root, env.blocked.recoveryPhase.planFile);
  const oldPlan = await readFile(oldPlanFile, 'utf8'); const turns = env.stages.length;
  env.ctl.block = false;
  const ready = await submit(env, candidate(env.blocked));
  const ran = env.stages.slice(turns);
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message); assert.equal(ready.state, 'paused');
  assert.deepEqual(ran, [`recovery-plan-review-${ready.recoveryPhase.id}-1`]);
  assert.equal(ran.filter(planner).length, 0); assert.equal(env.deployments(), 0);
  assert.notEqual(ready.recoveryPhase.id, env.blocked.recoveryPhase.id);
  assert.equal(ready.recoveryPhase.request.id, env.blocked.recoveryPhase.request.id);
  assert.equal(ready.recoveryPhase.corrections, env.blocked.recoveryPhase.corrections, 'an amendment does not renew or spend corrections');
  assert.equal(ready.recoveryPhaseHistory.at(-1).id, env.blocked.recoveryPhase.id);
  assert.equal(ready.recoveryPhaseHistory.at(-1).status, 'plan_failed');
  assert.equal(await readFile(oldPlanFile, 'utf8'), oldPlan, 'the failed phase plan artifact is untouched');
  const asked = env.requests.at(-1);
  assert.equal(asked.amendment, true); assert.deepEqual(asked.priorBlockers, BLOCKERS);
  assert.equal(ready.recoveryPhase.amendment.priorPhase, env.blocked.recoveryPhase.id);
  assert.deepEqual(ready.recoveryPhase.request.completed, env.blocked.recoveryPhase.request.completed);
  assert.equal(continuationAction(ready).action, 'approve-plan');
  // Stale or wrong approval is refused; the reviewed plan is the submitted one.
  await assert.rejects(validateRecoveryApproval(env.factory, ready, 'wrong'), /match/);
  assert.equal(ready.recoveryPhase.planDigest, digest(validateRecoveryPlan(candidate(env.blocked), env.blocked.recoveryPhase.request)));
  await writeFile(path.join(env.root, 'new-source.js'), 'changed');
  await assert.rejects(validateRecoveryApproval(env.factory, ready, ready.recoveryPhase.planDigest), /stale/);
  await rm(path.join(env.root, 'new-source.js'));
  const done = await env.factory.startRecovery(ready.id, ready.recoveryPhase.planDigest);
  assert.equal(done.state, 'completed', done.error?.message);
  assert.equal(done.recoveryPhase.done.length, ready.recoveryPhase.plan.slices.length); assert.equal(env.deployments(), 1);
  assert.equal(done.recoveryPhaseHistory.at(-1).id, env.blocked.recoveryPhase.id, 'history survives execution');
});

test('a blocked amendment records findings, starts no correction, and further review needs a new explicit candidate', async t => {
  const env = await setup(t);
  const blockedPlan = JSON.parse(await readFile(path.join(env.root, env.blocked.recoveryPhase.planFile), 'utf8'));
  const turns = env.stages.length;
  const first = candidate(env.blocked, 1);
  const again = await submit(env, first);
  const ran = env.stages.slice(turns);
  assert.deepEqual(ran, [`recovery-plan-review-${again.recoveryPhase.id}-1`], ran.join());
  assert.equal(again.state, 'failed'); assert.equal(again.recoveryPhase.status, 'plan_failed'); assert.equal(again.error.code, 'plan_blocked');
  assert.equal(again.recoveryPhase.blocked, true); assert.deepEqual(again.recoveryPhase.planBlockers, BLOCKERS);
  assert.equal(again.recoveryPhase.corrections, env.blocked.recoveryPhase.corrections);
  assert.equal(again.recoveryPhaseHistory.at(-1).id, env.blocked.recoveryPhase.id);
  assert.equal(continuationAction(again).action, 'amend-plan');
  // Duplicates of any reviewed candidate: reformatted, reordered, the original blocked plan, after restart.
  for (const [name, plan] of [['the same plan', first], ['reordered keys', reverse(first)], ['the original blocked plan', blockedPlan], ['the original with the request id restated', { ...blockedPlan, requestId: again.recoveryPhase.request.id }]]) {
    await refused(env, submit(env, plan, again), 'amendment_duplicate', 409);
  }
  await refused(env, submit(env, { ...first, requestId: 'another-request' }, again), 'amendment_invalid', 400);
  const restarted = new SoloFactory(env.opts);
  await refused(env, restarted.amendRecovery(again.id, { phaseId: again.recoveryPhase.id, plan: first }), 'amendment_duplicate', 409);
  assert.equal(env.stages.filter(stage => /^recovery-correction-/.test(stage)).length, 1, 'only the original automatic correction ever ran');
  // Plain retry of the exhausted fingerprint stays refused.
  await refused(env, env.factory.planRecovery(again.id), 'plan_inputs_unchanged');
  // A genuinely new candidate gets one more review.
  const before = env.stages.length;
  const third = await submit(env, candidate(env.blocked, 2), again);
  assert.equal(env.stages.length - before, 1); assert.equal(third.recoveryPhase.status, 'plan_failed');
  // Revised inputs keep the fresh-budget semantics, and the planner runs.
  await writeFile(path.join(env.root, '.factory/uploads/SPEC.md'), '§3 Group by capture day, as the contract says.\n'); env.ctl.block = false;
  const replanned = await env.factory.planRecovery(third.id);
  assert.equal(replanned.recoveryPhase.status, 'ready', replanned.error?.message); assert.equal(replanned.recoveryPhase.corrections, 0);
  assert.deepEqual(replanned.recoveryPhase.request.inputsChanged, ['.factory/uploads/SPEC.md']);
});

test('concurrent duplicate submissions start one review', async t => {
  const env = await setup(t); const turns = env.stages.length;
  const plan = candidate(env.blocked);
  const results = await Promise.allSettled([submit(env, plan), submit(env, plan)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'factory_busy');
  assert.equal(env.stages.slice(turns).filter(reviewer).length, 1);
});

const unchangedRejections = {
  'a stale phase id': ['amendment_stale', async () => ({ phaseId: 'old-phase' })],
  'a malformed replacement': ['amendment_invalid', async (env) => ({ plan: { version: 2, slices: 'nope' } })],
  'a non-object replacement': ['amendment_invalid', async () => ({ plan: 'text' })],
  'an omitted check': ['amendment_invalid', async (env) => { const plan = candidate(env.blocked); plan.slices.pop(); return { plan }; }],
  'an unknown check': ['amendment_invalid', async (env) => { const plan = candidate(env.blocked); plan.slices[0].closes = ['XX-99']; return { plan }; }],
  'changed inputs': ['amendment_inputs_changed', async (env) => { await writeFile(path.join(env.root, '.factory/uploads/SPEC.md'), 'changed spec'); }],
  'a changed frozen contract': ['amendment_inputs_changed', async (env) => { await writeFile(path.join(env.root, '.factory/PRD.md'), 'Narrowed'); }],
  'a changed source baseline': ['amendment_inputs_changed', async (env) => { await writeFile(path.join(env.root, 'new-source.js'), 'changed'); }],
  'modified review evidence': ['amendment_inputs_changed', async (env) => { const file = path.join(env.root, '.factory/review-result.json'); const r = JSON.parse(await readFile(file, 'utf8')); r.token = 'forged'; await writeFile(file, JSON.stringify(r)); }],
  'a dismissed run': ['amendment_not_allowed', async (env) => { const job = await env.store.read(env.blocked.id); job.dismissed = true; await env.store.writeState(job); }],
  'a completed run': ['amendment_not_allowed', async (env) => { const job = await env.store.read(env.blocked.id); job.state = 'completed'; await env.store.writeState(job); }],
};
for (const [name, [code, prepare]] of Object.entries(unchangedRejections)) test(`amendment refuses ${name} before any state write or agent turn`, async t => {
  const env = await setup(t);
  const extra = await prepare(env) ?? {};
  const submission = { phaseId: env.blocked.recoveryPhase.id, plan: candidate(env.blocked), ...extra };
  await refused(env, env.factory.amendRecovery(env.blocked.id, submission), code);
  // The shared preflight (HTTP) reaches the same verdict without a controller.
  const { assertPlanAmendable } = await import('../src/factory.mjs');
  await assert.rejects(assertPlanAmendable(env.store, await env.store.read(env.blocked.id), submission, { maxRepairs: 1 }), error => error.code === code);
  assert.equal(env.deployments(), 0);
});

test('an active writer refuses an amendment before any state write', async t => {
  const env = await setup(t);
  env.factory.active = { jobId: 'other' };
  await refused(env, submit(env, candidate(env.blocked)), 'factory_busy');
  const { assertPlanAmendable } = await import('../src/factory.mjs');
  await assert.rejects(assertPlanAmendable(env.store, env.blocked, { phaseId: env.blocked.recoveryPhase.id, plan: candidate(env.blocked) }, { maxRepairs: 1, busy: true }), error => error.code === 'amendment_not_allowed');
});

test('a malformed original plan is replaced without losing its raw evidence', async t => {
  const env = await setup(t, { malformed: true });
  const phase = env.blocked.recoveryPhase;
  assert.match(phase.planBlockers[0], /JSON|Unexpected|valid/i);
  assert.equal(await readFile(path.join(env.root, phase.planFile), 'utf8'), 'not json {');
  env.ctl.block = false;
  const ready = await submit(env, candidate(env.blocked));
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
  const evidence = await readdir(env.store.jobDir(ready.id));
  assert.ok(evidence.includes(`recovery-${ready.recoveryPhase.id}-submitted.json`), evidence.join());
  assert.equal(await readFile(path.join(env.store.jobDir(ready.id), `recovery-${ready.recoveryPhase.id}-prior-plan.json`), 'utf8'), 'not json {');
  assert.equal(await readFile(path.join(env.root, phase.planFile), 'utf8'), 'not json {', 'the original raw artifact stays');
});

test('a run blocked before the amendment fields existed has supported guidance and can be amended', async t => {
  const env = await setup(t);
  const saved = await env.store.read(env.blocked.id);
  delete saved.recoveryPhase.blocked; delete saved.recoveryPhase.reviewedPlans; delete saved.recoveryPhase.amendment;
  saved.error = { code: 'unexpected_error', message: saved.error.message, details: {} };
  await env.store.writeState(saved);
  assert.equal(continuationAction(saved).action, 'amend-plan');
  env.ctl.block = false;
  const ready = await submit(env, candidate(saved), saved);
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
  // The legacy plan on disk still counts as already reviewed.
  const legacy = await setup(t);
  const stripped = await legacy.store.read(legacy.blocked.id); delete stripped.recoveryPhase.reviewedPlans; await legacy.store.writeState(stripped);
  const onDisk = JSON.parse(await readFile(path.join(legacy.root, stripped.recoveryPhase.planFile), 'utf8'));
  await refused(legacy, submit(legacy, onDisk, stripped), 'amendment_duplicate', 409);
});

for (const mode of ['modify', 'fail']) test(`a reviewer that ${mode === 'modify' ? 'edits the plan' : 'is interrupted'} yields no verdict, and the retry continues only the review`, async t => {
  const env = await setup(t); const turns = env.stages.length;
  env.ctl.block = false; env.ctl[mode] = true;
  const parked = await submit(env, candidate(env.blocked));
  assert.equal(parked.state, 'failed'); assert.equal(parked.recoveryPhase.status, 'plan_failed');
  assert.notEqual(parked.error.code, 'plan_blocked'); assert.notEqual(parked.recoveryPhase.blocked, true);
  if (mode === 'modify') assert.match(parked.error.message, /changed the plan/);
  const next = continuationAction(parked);
  assert.deepEqual([next.action, next.label, next.endpoint], ['retry-plan', 'Resume plan review', `/api/jobs/${parked.id}/recovery-plan`]);
  assert.match(next.reason, /does not start the planner/);
  env.ctl.modify = false;
  const ready = await env.factory.planRecovery(parked.id);
  const ran = env.stages.slice(turns);
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
  assert.deepEqual(ran, [`recovery-plan-review-${parked.recoveryPhase.id}-1`, `recovery-plan-review-${parked.recoveryPhase.id}-2`]);
  assert.equal(ran.filter(planner).length, 0);
  assert.equal(ready.recoveryPhase.id, parked.recoveryPhase.id); assert.equal(ready.recoveryPhase.corrections, env.blocked.recoveryPhase.corrections);
  assert.equal(ready.recoveryPhase.planDigest, digest(validateRecoveryPlan(candidate(env.blocked), env.blocked.recoveryPhase.request)), 'the submitted plan, not the reviewer edit, is what was approved');
  assert.equal(env.stages.filter(stage => /^recovery-correction-/.test(stage)).length, 1);
});

test('the plan key ignores formatting and the request id but not content', () => {
  const plan = { version: 2, requestId: 'a', slices: [{ id: 'X', title: 'x' }] };
  assert.equal(planKey(plan), planKey(reverse({ ...plan, requestId: 'b' })));
  assert.notEqual(planKey(plan), planKey({ ...plan, slices: [{ id: 'X', title: 'y' }] }));
});

test('HTTP: packet download, a 540KB bounded submission, refusals that change nothing, and the review-then-approve journey', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'solo-http-amendment-'));
  const fixture = createFixtureProvider(); const stages = []; let block = true;
  const saved = process.env.SOLOFACTORY_MAX_REPAIRS; process.env.SOLOFACTORY_MAX_REPAIRS = '0'; // the first block exhausts corrections
  const app = await createSoloFactoryServer({ home, fixtureMode: true, providerFactory: () => ({ id: 'fixture', async run(args) {
    stages.push(args.context.stage);
    const result = await fixture.run(args);
    if (reviewer(args.context.stage) && block) {
      const file = path.join(args.cwd, '.factory/plan-review-result.json'); const r = JSON.parse(await readFile(file, 'utf8'));
      r.verdict = 'blocked'; r.blockers = BLOCKERS; await writeFile(file, JSON.stringify(r));
    }
    return result;
  } }) });
  if (saved === undefined) delete process.env.SOLOFACTORY_MAX_REPAIRS; else process.env.SOLOFACTORY_MAX_REPAIRS = saved;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) => fetch(`${base}/api/jobs/${job.id}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const read = async () => (await (await fetch(`${base}/api/jobs/${job.id}`)).json()).job;
  // Parked state lands a beat before the scheduler releases the run; until then the API still answers busy (nextAction none).
  const settle = async () => { let now; const deadline = Date.now() + 30_000; do { await new Promise(r => setTimeout(r, 50)); now = await read(); } while ((!['paused', 'failed'].includes(now.state) || now.nextAction?.action === 'none') && Date.now() < deadline); return now; };
  const job = await app.store.create({ brief: { workingName: 'Amendment HTTP', mustHaves: ['Edit live albums'], acceptanceScenarios: ['New photos enter a saved album'] }, transcript: [{ role: 'user', content: 'Recover existing behavior' }], provider: 'fixture', sdlc: 'single' });
  const cwd = app.store.appDir();
  await mkdir(path.join(cwd, '.factory'), { recursive: true });
  await writeFile(path.join(cwd, '.factory/requirements.json'), JSON.stringify(job.brief));
  for (const stage of ['specification', 'build']) await fixture.run({ cwd, context: { stage, job } });
  job.reviewRequest = await prepareReview(cwd, job); job.reviewContractDigest = job.reviewRequest.contractDigest;
  await fixture.run({ cwd, context: { stage: 'review', job } });
  const reportPath = path.join(cwd, '.factory/review-result.json'); const report = JSON.parse(await readFile(reportPath));
  report.verdict = 'blocked'; report.blockers = ['Missing live rules']; report.checks[0].status = 'missing';
  await writeFile(reportPath, JSON.stringify(report)); await app.store.commit('fixture baseline');
  job.startedAt = new Date().toISOString(); job.state = 'failed'; job.failedState = 'reviewing'; job.error = { code: 'review_rejected', message: 'Missing live rules' };
  job.attempt = 2; job.recovery = buildRecovery(job, cwd); await app.store.writeState(job);
  assert.equal((await post('recovery-plan', {})).status, 202);
  const blocked = await settle();
  assert.equal(blocked.recoveryPhase.status, 'plan_failed', blocked.error?.message); assert.equal(blocked.recoveryPhase.blocked, true);
  // API and controller agree on the one allowed action; the retry route points at it.
  assert.equal(blocked.nextAction.action, 'amend-plan');
  assert.deepEqual(blocked.nextAction, continuationAction(await app.store.read(job.id), { maxRepairs: 0 }));
  const retry = await post('recovery-plan', {}); assert.equal(retry.status, 409);
  const retried = await retry.json(); assert.equal(retried.nextAction.action, 'amend-plan'); assert.deepEqual(retried.blockers, BLOCKERS);
  // The packet is an attachment within owned paths and carries what a person or agent needs.
  const download = await fetch(`${base}/api/jobs/${job.id}/recovery-plan-packet`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment; filename="plan-help-/);
  const packet = await download.json();
  assert.equal(packet.kind, 'solofactory-plan-correction-packet'); assert.equal(packet.phaseId, blocked.recoveryPhase.id);
  assert.deepEqual(packet.blockers, BLOCKERS); assert.equal(packet.repairsStarted, false);
  assert.equal(packet.submit.endpoint, `/api/jobs/${job.id}/recovery-review`);
  assert.ok(packet.currentPlan?.slices?.length, 'the preserved plan is included');
  const stateFile = path.join(app.store.jobDir(job.id), 'state.json'); const raw = await readFile(stateFile, 'utf8'); const turns = stages.length;
  const unchanged = async (route, body, status, code) => {
    const response = await post(route, body); assert.equal(response.status, status, await response.clone().text());
    if (code) assert.equal((await response.json()).code, code);
    assert.equal(await readFile(stateFile, 'utf8'), raw); assert.equal(stages.length, turns);
  };
  const plan = candidate({ ...blocked, recoveryPhase: { ...blocked.recoveryPhase, request: packet.request } });
  const big = structuredClone(plan); big.slices[0].objective += ' filler'.repeat(80_000);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) >= 540_000);
  await unchanged('recovery-review', { phaseId: 'old-phase', plan }, 409, 'amendment_stale');
  await unchanged('recovery-review', { phaseId: blocked.recoveryPhase.id, plan: { version: 2 } }, 400, 'amendment_invalid');
  await unchanged('recovery-review', '{ not json', 400);
  await unchanged('recovery-review', { phaseId: blocked.recoveryPhase.id, plan: { ...plan, pad: 'x'.repeat(4_100_000) } }, 413, 'amendment_too_large');
  await unchanged('recovery-review', { phaseId: blocked.recoveryPhase.id, plan: big, junk: 'x'.repeat(4_200_000) }, 413, 'amendment_too_large');
  assert.equal((await post('recovery-start', { planDigest: 'wrong' })).status, 409);
  // A 540KB plan is accepted whole, reviewed once, and parks ready without executing anything.
  block = false;
  const accepted = await post('recovery-review', { phaseId: blocked.recoveryPhase.id, plan: big }); assert.equal(accepted.status, 202, await accepted.clone().text());
  const ready = await settle();
  assert.equal(ready.recoveryPhase.status, 'ready', ready.error?.message);
  assert.deepEqual(stages.slice(turns), [`recovery-plan-review-${ready.recoveryPhase.id}-1`]);
  assert.ok(Buffer.byteLength(JSON.stringify(ready.recoveryPhase.plan)) >= 540_000, 'nothing was truncated');
  await unchanged2(post, ready, big);
  assert.equal(ready.nextAction.action, 'approve-plan');
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/recovery-plan-packet`)).status, 409);
  assert.equal((await post('recovery-start', { planDigest: 'wrong' })).status, 409);
  // The dashboard drives the same allowed action with a file input and a retained selection.
  const dashboard = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(dashboard, /next\?\.action === "amend-plan"/); assert.match(dashboard, /recovery-plan-packet/);
  assert.match(dashboard, /type = "file"/); assert.match(dashboard, /recovery-review/); assert.match(dashboard, /state\.amendment/);
});

// A second submission against a phase that already moved on is stale, not a second review.
async function unchanged2(post, ready, plan) {
  const response = await post('recovery-review', { phaseId: ready.recoveryPhase.id, plan }); assert.equal(response.status, 409);
}
