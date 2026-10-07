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
