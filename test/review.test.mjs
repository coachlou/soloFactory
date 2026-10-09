import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/store.mjs';
import { SoloFactory } from '../src/factory.mjs';
import { createFixtureProvider } from '../src/fixture-provider.mjs';

async function setup(t, mutate, { maxRepairs = 0, sdlc = 'single' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobStore(root);
  await store.init();
  const job = await store.create({ brief: { workingName: 'Review regression', mustHaves: ['Live saved searches'], acceptanceScenarios: ['A new matching photo enters its saved album.'] }, transcript: [{ role: 'user', content: 'Build a real smart album.' }], provider: 'fixture', sdlc });
  const fixture = createFixtureProvider();
  let deployments = 0;
  let reviews = 0;
  const factory = new SoloFactory({ store, maxRepairs,
    commandRunner: async () => ({ code: 0, output: 'All existing tests pass' }),
    deployer: async () => { deployments++; return { status: 'live', url: 'http://127.0.0.1:9991' }; },
    provider: { id: 'fixture', async run(args) {
      const result = await fixture.run(args);
      if (args.context.stage === 'review') reviews++;
      await mutate?.(args, reviews);
      return result;
    } },
  });
  return { store, job, factory, root, deployments: () => deployments, reviews: () => reviews };
}
async function changeReport(args, change) {
  if (args.context.stage !== 'review') return;
  const file = path.join(args.cwd, '.factory/review-result.json');
  const report = JSON.parse(await readFile(file, 'utf8'));
  change(report);
  await writeFile(file, JSON.stringify(report));
}

for (const sdlc of ['single', 'slices']) test(`${sdlc}: green tests cannot override missing smart-album functionality`, async t => {
  const env = await setup(t, args => changeReport(args, r => { r.verdict = 'blocked'; r.blockers = ['Live membership is missing']; r.checks[0].status = 'missing'; }), { sdlc });
  const result = await env.factory.start(env.job.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.failedState, 'reviewing');
  assert.equal(result.error.code, 'review_rejected');
  assert.equal(env.deployments(), 0);
  const events = await env.store.events(env.job.id, 500);
  assert.ok(events.some(e => e.type === 'gate.failed' && e.gate === 'review'));
  assert.ok(!events.some(e => e.type === 'job.completed'));
});

const badReports = {
  'missing verdict file': async args => { if (args.context.stage === 'review') await rm(path.join(args.cwd, '.factory/review-result.json')); },
  'malformed verdict': async args => { if (args.context.stage === 'review') await writeFile(path.join(args.cwd, '.factory/review-result.json'), '{'); },
  'stale verdict token': args => changeReport(args, r => { r.token = 'old-run'; }),
  'partial scenario coverage': args => changeReport(args, r => { r.checks.pop(); }),
  'duplicate IDs': args => changeReport(args, r => { r.checks[1].id = r.checks[0].id; }),
  'pass with a blocker': args => changeReport(args, r => { r.blockers = ['No browser evidence']; }),
  'unverified requirement': args => changeReport(args, r => { r.checks[0].status = 'unverified'; }),
  'empty evidence': args => changeReport(args, r => { r.checks[0].evidence = []; }),
  'missing evidence file': args => changeReport(args, r => { r.checks[0].evidence = ['absent.png']; }),
  'owner-data evidence': args => changeReport(args, r => { r.checks[0].evidence = ['data/private.jpg']; }),
  'self-referential evidence': args => changeReport(args, r => { r.checks[0].evidence = ['.factory/review-result.json']; }),
  'contract rewritten by reviewer': async args => { if (args.context.stage === 'review') await writeFile(path.join(args.cwd, '.factory/ACCEPTANCE.md'), 'Reduced scope'); },
};
for (const [name, mutate] of Object.entries(badReports)) test(`blocks ${name} before deployment`, async t => {
  const env = await setup(t, mutate);
  const result = await env.factory.start(env.job.id);
  assert.equal(result.error?.code, 'review_rejected');
  assert.equal(result.state, 'failed');
  assert.equal(env.deployments(), 0);
});

test('a failed review repairs within budget then requires a fresh passing verdict', async t => {
  const env = await setup(t, (args, reviews) => reviews === 1 ? changeReport(args, r => { r.verdict = 'blocked'; r.blockers = ['Fix missing workflow']; }) : null, { maxRepairs: 1 });
  const result = await env.factory.start(env.job.id);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(result.attempt, 1);
  assert.equal(env.reviews(), 2);
  assert.equal(env.deployments(), 1);
});

test('exhausted review budget parks; resume obtains a fresh verdict', async t => {
  let blocked = true;
  const env = await setup(t, args => blocked ? changeReport(args, r => { r.verdict = 'blocked'; r.blockers = ['Missing evidence']; }) : null, { maxRepairs: 1 });
  const failed = await env.factory.start(env.job.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempt, 1);
  assert.equal(env.reviews(), 2);
  assert.equal(env.deployments(), 0);
  const oldToken = failed.reviewRequest.token;
  blocked = false;
  const resumed = await env.factory.resume(env.job.id);
  assert.equal(resumed.state, 'completed', resumed.error?.message);
  assert.notEqual(resumed.reviewRequest.token, oldToken);
});

test('repair cannot narrow the frozen contract to satisfy review', async t => {
  const env = await setup(t, async args => {
    if (args.context.stage === 'review') await changeReport(args, r => { r.verdict = 'blocked'; r.blockers = ['Missing capability']; });
    if (args.context.stage === 'repair-1') await writeFile(path.join(args.cwd, '.factory/ACCEPTANCE.md'), 'Waived missing capability');
  }, { maxRepairs: 1 });
  const result = await env.factory.start(env.job.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error.message, /scope cannot be narrowed/);
  assert.equal(env.deployments(), 0);
});

 test('legacy recovery without a frozen contract cannot complete', async t => {
  const env = await setup(t, async args => {
    if (args.context.stage === 'build') await rm(path.join(args.cwd, '.factory/requirements.json'));
  });
  const result = await env.factory.start(env.job.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'review_rejected');
  assert.equal(env.deployments(), 0);
});

test('repair receives every unfinished requirement and blocker, not only the first ID', async t => {
  const env = await setup(t, args => changeReport(args, report => {
    report.verdict = 'blocked'; report.blockers = ['No real metadata extractor', 'No live album evaluator'];
    report.checks[0].status = 'missing'; report.checks[1].status = 'unverified';
  }), { maxRepairs: 1 });
  const result = await env.factory.start(env.job.id);
  assert.equal(result.state, 'failed');
  const failure = await readFile(path.join(env.root, '.factory/last-failure-1.txt'), 'utf8');
  for (const text of ['MH-1', 'Live saved searches', 'SC-1', 'A new matching photo enters its saved album.', 'No real metadata extractor', 'No live album evaluator', '.factory/REVIEW.md']) assert.ok(failure.includes(text), text);
  assert.equal(result.error.details.failedChecks.length, 2);
  assert.equal(env.deployments(), 0);
});

test('owner resume can repair an exhausted review without overwriting prior evidence', async t => {
  let recovered = false;
  const env = await setup(t, async args => {
    if (args.context.stage === 'repair-2') recovered = true;
    if (!recovered) await changeReport(args, r => { r.verdict = 'blocked'; r.blockers = ['Missing live album behavior']; });
  }, { maxRepairs: 1 });
  const failed = await env.factory.start(env.job.id);
  assert.equal(failed.state, 'failed');
  const oldFailure = await readFile(path.join(env.root, '.factory/last-failure-1.txt'), 'utf8');
  const resumed = await env.factory.resume(env.job.id);
  assert.equal(resumed.state, 'completed', resumed.error?.message);
  assert.equal(resumed.id, failed.id);
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.reviewContractDigest, failed.reviewContractDigest);
  assert.equal(await readFile(path.join(env.root, '.factory/last-failure-1.txt'), 'utf8'), oldFailure);
  assert.match(await readFile(path.join(env.root, '.factory/last-failure-2.txt'), 'utf8'), /Missing live album behavior/);
  assert.equal(env.deployments(), 1);
});

test('owner review resume grants a bounded budget and parks again when still incomplete', async t => {
  const env = await setup(t, args => changeReport(args, r => { r.verdict = 'blocked'; r.blockers = ['Still incomplete']; }), { maxRepairs: 1 });
  await env.factory.start(env.job.id);
  const resumed = await env.factory.resume(env.job.id);
  assert.equal(resumed.state, 'failed');
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.repairBudgetLimit, 2);
  assert.equal(env.deployments(), 0);
});

// --- registry, candidate binding and plan verdicts (no factory) ---
import { mkdir } from 'node:fs/promises';
import { originalChecks, prepareReview, validateReview, preparePlanReview, validatePlanReview } from '../src/review.mjs';

async function contractDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'solo-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, '.factory'));
  for (const f of ['requirements.json', 'PRD.md', 'PLAN.md', 'ACCEPTANCE.md']) await writeFile(path.join(dir, '.factory', f), f);
  await writeFile(path.join(dir, 'proof.test.mjs'), 'ok');
  return dir;
}
const passReport = (req, extra = {}) => ({ version: 1, jobId: req.jobId, token: req.token, contractDigest: req.contractDigest, verdict: 'pass', blockers: [],
  checks: req.checks.map(c => ({ id: c.id, status: 'pass', evidence: ['proof.test.mjs'] })), ...extra });

test('one original-check registry numbers MH then SC', () => {
  assert.deepEqual(originalChecks({ mustHaves: ['a', 'b'], acceptanceScenarios: ['c'] }).map(c => c.id), ['MH-1', 'MH-2', 'SC-1']);
  assert.deepEqual(originalChecks({}), []);
});

test('scoped review uses its own checks and binds the verdict to the candidate', async t => {
  const dir = await contractDir(t);
  const job = { id: 'job-1', brief: { mustHaves: ['a', 'b'] } };
  const req = await prepareReview(dir, job, { checks: [{ id: 'MH-2', text: 'b' }, { id: 'F-1', text: 'obligation' }], candidate: 'cand-1' });
  assert.deepEqual(req.checks.map(c => c.id), ['MH-2', 'F-1']);
  const file = path.join(dir, '.factory/review-result.json');
  await writeFile(file, JSON.stringify(passReport(req)));
  await assert.rejects(validateReview(dir, req), /not bound to the checked candidate/);
  await writeFile(file, JSON.stringify(passReport(req, { candidate: 'cand-0' })));
  await assert.rejects(validateReview(dir, req), /not bound to the checked candidate/);
  await writeFile(file, JSON.stringify(passReport(req, { candidate: 'cand-1' })));
  await validateReview(dir, req);
  const missing = passReport(req, { candidate: 'cand-1' }); missing.checks[1].evidence = ['captures/screen.png'];
  await writeFile(file, JSON.stringify(missing));
  await assert.rejects(validateReview(dir, req), /captures\/screen\.png for F-1 does not exist/);
});

test('plan verdicts bind token, plan digest and contract; blocked names its blocker', async t => {
  const dir = await contractDir(t);
  const req = await preparePlanReview(dir, { id: 'job-1' }, 'p'.repeat(64));
  const file = path.join(dir, '.factory/plan-review-result.json');
  const verdict = extra => writeFile(file, JSON.stringify({ ...req, verdict: 'approve', blockers: [], ...extra }));
  await assert.rejects(validatePlanReview(dir, req), /no readable verdict/);
  await writeFile(file, '{'); await assert.rejects(validatePlanReview(dir, req), /no readable verdict/);
  await verdict({ token: 'old' }); await assert.rejects(validatePlanReview(dir, req), /stale/);
  await verdict({ planDigest: 'q'.repeat(64) }); await assert.rejects(validatePlanReview(dir, req), /stale/);
  await verdict({ contractDigest: 'x' }); await assert.rejects(validatePlanReview(dir, req), /stale/);
  await verdict({ verdict: 'ok' }); await assert.rejects(validatePlanReview(dir, req), /invalid/);
  await verdict({ verdict: 'blocked', blockers: ['MH-2 has no negative case'] });
  await assert.rejects(validatePlanReview(dir, req), e => /MH-2 has no negative case/.test(e.message) && e.details.blockers.length === 1);
  await verdict({ blockers: ['still open'] }); await assert.rejects(validatePlanReview(dir, req), /still open/);
  await verdict(); assert.equal((await validatePlanReview(dir, req)).verdict, 'approve');
  const fresh = await preparePlanReview(dir, { id: 'job-1' }, 'p'.repeat(64));
  assert.notEqual(fresh.token, req.token);
  await assert.rejects(validatePlanReview(dir, fresh), /no readable verdict/);
});
