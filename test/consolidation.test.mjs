import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/store.mjs';
import { SoloFactory, nodeOptionPath, runnerCrash } from '../src/factory.mjs';
import { assertConsolidation, caseResults, validateFeaturePlan } from '../src/wbs.mjs';
import { REVIEW_BAR, TEST_SCRIPT_RULE, OWN_FILES_RULE, featurePlanPrompt, specificationPrompt, featureBuildPrompt, featureReviewPrompt, repairPrompt } from '../src/prompts.mjs';

// Consolidating overlapping obligations into one requirement with explicit cases, shared by new-run and
// repair planning. The cases keep every distinct field, action, boundary, failure condition and surface,
// cite exactly the requirement's checks and sources, and are proved one by one.
const SPEC = 'SPEC.md';
const checks = [{ id: 'MH-1', text: 'Upload photos' }, { id: 'SC-1', text: 'Oversized uploads are refused' }];
const opts = { jobId: 'job', contractDigest: 'contract', checks, sources: [SPEC, 'PLAN.md'] };
const at = locator => ({ path: SPEC, locator });
const proof = { command: ['node', '--test', 'test/upload.test.mjs'], expect: 'every upload case passes' };
const plan = acceptance => ({ version: 2, jobId: 'job', contractDigest: 'contract', compatibility: [],
  slices: [{ id: 'UPLOAD', title: 'Upload', objective: 'Photos upload with limits', demo: 'Open the library and upload a photo', dependsOn: [], closes: ['MH-1', 'SC-1'], acceptance }] });
const cases = () => [
  { id: 'UP-API-OK', surface: 'api', action: 'POST a 1 MB jpeg', expect: '201 and the photo is listed', refs: ['MH-1'], sources: [at('§1 Upload')] },
  { id: 'UP-API-BIG', surface: 'api', action: 'POST a 26 MB jpeg', boundary: '25 MB', expect: '413 and nothing is stored', refs: ['SC-1'], sources: [at('§2 Limits')] },
  { id: 'UP-UI-BIG', surface: 'browser', action: 'Drop a 26 MB jpeg', field: 'upload zone', boundary: '25 MB', expect: 'inline size error, no request sent', refs: ['SC-1'], sources: [at('§2 Limits')] },
];
const requirement = (extra = {}) => ({ id: 'UPLOAD-LIMITS', behavior: 'Uploads accept photos and refuse oversized files on every surface', refs: ['MH-1', 'SC-1'],
  sources: [at('§1 Upload'), at('§2 Limits')], proof, cases: cases(), ...extra });
const rejects = (acceptance, pattern) => assert.throws(() => validateFeaturePlan(plan(acceptance), opts), pattern);

test('a requirement keeps its case table: each case has its own surface, action, field, boundary and expected result', () => {
  const valid = validateFeaturePlan(plan([requirement()]), opts);
  const [item] = valid.slices[0].acceptance;
  assert.deepEqual(item.cases.map(entry => [entry.id, entry.surface, entry.field ?? null, entry.boundary ?? null]),
    [['UP-API-OK', 'api', null, null], ['UP-API-BIG', 'api', null, '25 MB'], ['UP-UI-BIG', 'browser', 'upload zone', '25 MB']]);
  assert.equal(item.cases[1].expect, '413 and nothing is stored');
});

test('a case may cite no check when its siblings cover the requirement, and every case problem is named at once', () => {
  // Seen on the first real-provider plan: a package constraint case with refs [] spent a whole correction round.
  const constraint = { id: 'UP-NODEPS', surface: 'unit', action: 'Read package.json', expect: 'no runtime dependencies', refs: [], sources: [at('§1 Upload')] };
  const [item] = validateFeaturePlan(plan([requirement({ cases: [...cases(), constraint] })]), opts).slices[0].acceptance;
  assert.deepEqual(item.cases.at(-1).refs, []);
  // Seen on the second: a correction reworded one compound locator and every case citing it stopped matching.
  // Locators are free text, so a case matches its requirement's sources by file and keeps its own locator.
  const reworded = cases().map((entry, i) => i === 1 ? { ...entry, sources: [at('§2 Limits (25 MB cap)')] } : entry);
  assert.equal(validateFeaturePlan(plan([requirement({ cases: reworded })]), opts).slices[0].acceptance[0].cases[1].sources[0].locator, '§2 Limits (25 MB cap)');
  assert.throws(() => validateFeaturePlan(plan([requirement({ cases: cases().map((entry, i) => i ? { ...entry, refs: ['SC-9'], sources: [{ path: 'OTHER.md', locator: '§9 Elsewhere' }] } : entry) })]), opts), (error) => {
    for (const part of [/UP-API-BIG cites SC-9/, /UP-UI-BIG cites SC-9/, /UP-API-BIG cites OTHER\.md §9 Elsewhere/, /allowed: MH-1, SC-1/, /allowed: SPEC\.md\)/]) assert.match(error.message, part);
    return true;
  });
});

test('a case expects a short exact result like "28", but not an empty one', () => {
  // Seen on the fourth real-provider plan: expect "28" (days in February) spent a correction round.
  const short = cases().map((entry, i) => i ? entry : { ...entry, action: 'GET', expect: '28' });
  assert.equal(validateFeaturePlan(plan([requirement({ cases: short })]), opts).slices[0].acceptance[0].cases[0].expect, '28');
  rejects([requirement({ cases: cases().map((entry, i) => i ? entry : { ...entry, expect: ' ' }) })], /UP-API-OK needs the action/);
});

test('a plan without cases normalizes exactly as before, so existing plan digests do not change', () => {
  const { cases: _, ...plain } = requirement();
  const [item] = validateFeaturePlan(plan([plain]), opts).slices[0].acceptance;
  assert.deepEqual(Object.keys(item), ['id', 'behavior', 'refs', 'proof', 'sources']);
});

test('a case table cannot drop a check or source citation, cite one its requirement lacks, or reuse an id', () => {
  rejects([requirement({ cases: cases().slice(0, 1) })], /cites SC-1 but none of its cases does/);
  assert.doesNotThrow(() => validateFeaturePlan(plan([requirement({ sources: [at('§1 Upload'), at('§2 Limits'), { path: 'PLAN.md', locator: '§4 Storage' }] })]), opts)); // a requirement may cite a file no case cites
  rejects([requirement({ refs: ['MH-1'], cases: cases().slice(0, 1).concat({ ...cases()[1], refs: ['SC-1'] }) })], /UP-API-BIG cites SC-1, which UPLOAD-LIMITS does not/);
  rejects([requirement({ cases: cases().map((entry, i) => i ? entry : { ...entry, sources: [{ path: 'OTHER.md', locator: '§9 Elsewhere' }] }) })], /UP-API-OK cites OTHER\.md §9 Elsewhere, which UPLOAD-LIMITS does not/);
  rejects([requirement({ cases: cases().map((entry, i) => i ? entry : { ...entry, surface: 'magic' }) })], /needs a surface/);
  rejects([requirement({ cases: cases().map((entry, i) => i ? entry : { ...entry, id: 'UPLOAD-LIMITS' }) })], /duplicate case id/);
  rejects([requirement({ cases: cases().map(entry => ({ ...entry, supersedes: ['OLD-1'] })) })], /repeated supersedes/);
  rejects([requirement({ cases: [] })], /malformed cases table/);
});

// The reviewed plan an owner replacement consolidates: three separate obligations.
const separate = () => validateFeaturePlan(plan([
  { id: 'OLD-OK', behavior: 'API accepts a 1 MB jpeg and lists it', refs: ['MH-1'], sources: [at('§1 Upload')], proof: { command: ['node', '--test', 'test/ok.test.mjs'], expect: 'passes' } },
  { id: 'OLD-BIG-API', behavior: 'API refuses a 26 MB jpeg with 413', refs: ['SC-1'], sources: [at('§2 Limits')], proof: { command: ['node', '--test', 'test/big.test.mjs'], expect: 'passes' } },
  { id: 'OLD-BIG-UI', behavior: 'Browser shows an inline size error for a 26 MB jpeg', refs: ['SC-1'], sources: [at('§2 Limits')], proof: { command: ['node', '--test', 'test/ui.test.mjs'], expect: 'passes' } },
]), opts);
const mapped = (edit = list => list) => validateFeaturePlan(plan([requirement({ cases: edit(cases().map((entry, i) => ({ ...entry, supersedes: [['OLD-OK', 'OLD-BIG-API', 'OLD-BIG-UI'][i]] }))) })]), opts);

test('a consolidation maps every reviewed obligation to exactly one case without weakening its citations', () => {
  assert.doesNotThrow(() => assertConsolidation(mapped(), separate()));
  assert.throws(() => assertConsolidation(mapped(list => list.map((entry, i) => i === 2 ? { ...entry, supersedes: undefined } : entry)), separate()), /OLD-BIG-UI \(UPLOAD\) is neither kept nor superseded/);
  const base = separate(); base.slices[0].acceptance[1].refs.push('MH-1');
  assert.throws(() => assertConsolidation(mapped(), base), /case UP-API-BIG drops OLD-BIG-API's checks MH-1/);
  const cited = separate(); cited.slices[0].acceptance[2].sources.push(at('§3 Errors'));
  assert.throws(() => assertConsolidation(mapped(), cited), /case UP-UI-BIG drops OLD-BIG-UI's source SPEC\.md §3 Errors/);
  const later = separate(); later.slices[0].acceptance[0].proof.pending = 'integration';
  assert.throws(() => assertConsolidation(mapped(), later), /changes when OLD-OK is proved \(integration → at build\)/);
  assert.throws(() => assertConsolidation(mapped(list => list.map((entry, i) => i ? entry : { ...entry, supersedes: ['OLD-OK', 'OLD-GHOST'] })), separate()), /supersedes OLD-GHOST, which the reviewed plan does not contain/);
  const both = separate(); both.slices[0].acceptance[0].id = 'UPLOAD-LIMITS';
  assert.throws(() => assertConsolidation(mapped(list => list.map((entry, i) => i ? entry : { ...entry, supersedes: ['OLD-OK', 'UPLOAD-LIMITS'] })), both), /UPLOAD-LIMITS is kept and also superseded/);
});

// Regression shape from a real recovery: 17 features, 578 one-command obligations, consolidated into
// requirements of up to 64 cases. The count is an example to test against, not a target.
test('a large plan consolidated into case tables maps every obligation, and one unmapped obligation is named', () => {
  const sizes = [64, 60, 48, 40, 40, 36, 36, 32, 32, 30, 28, 28, 24, 24, 20, 20, 16];
  assert.equal(sizes.reduce((sum, n) => sum + n, 0), 578);
  const ids = sizes.map((_, f) => `F${f + 1}`);
  const many = consolidated => ({ version: 2, jobId: 'job', contractDigest: 'contract', compatibility: [],
    slices: sizes.map((n, f) => ({ id: ids[f], title: `Feature ${f + 1}`, objective: `Feature ${f + 1} works`, demo: `Open feature ${f + 1} and use it`, dependsOn: f ? [ids[f - 1]] : [], closes: f === sizes.length - 1 ? ['MH-1', 'SC-1'] : [],
      acceptance: consolidated
        ? [{ id: `${ids[f]}-REQ`, behavior: `Feature ${f + 1} meets all of its stated obligations`, refs: ['MH-1', 'SC-1'], sources: [at(`§${f + 1}`)], proof: { command: ['node', '--test', `test/f${f + 1}.test.mjs`], expect: 'every case passes' },
          cases: Array.from({ length: n }, (_, i) => ({ id: `${ids[f]}-C${i + 1}`, surface: i % 2 ? 'browser' : 'api', action: `Case ${i + 1}`, expect: `Result ${i + 1}`, refs: [i % 2 ? 'SC-1' : 'MH-1'], sources: [at(`§${f + 1}`)], supersedes: [`${ids[f]}-O${i + 1}`] })) }]
        : Array.from({ length: n }, (_, i) => ({ id: `${ids[f]}-O${i + 1}`, behavior: `Feature ${f + 1} obligation ${i + 1} holds`, refs: [i % 2 ? 'SC-1' : 'MH-1'], sources: [at(`§${f + 1}`)], proof: { command: ['node', '--test', `test/f${f + 1}-${i + 1}.test.mjs`], expect: 'passes' } })),
    })) });
  const base = validateFeaturePlan(many(false), opts);
  const consolidated = validateFeaturePlan(many(true), opts);
  assert.equal(consolidated.slices.flatMap(slice => slice.acceptance[0].cases).length, 578);
  assert.doesNotThrow(() => assertConsolidation(consolidated, base));
  consolidated.slices[3].acceptance[0].cases[7].supersedes = [];
  assert.throws(() => assertConsolidation(consolidated, base), /\(1 problem\): F4-O8 \(F4\) is neither kept nor superseded/);
});

test('each case passes only on its own passing test; a failure, skip or todo, or silence does not pass it', () => {
  const list = ['C-A', 'C-B', 'C-C', 'C-D', 'X-01'].map(id => ({ id, requirement: 'REQ' }));
  const events = [
    { type: 'test:pass', name: '[C-A] passes' }, { type: 'test:pass', name: '[C-A] suite' },
    { type: 'test:pass', name: '[C-B] ok' }, { type: 'test:fail', name: '[C-B] retry' },
    { type: 'test:pass', name: '[C-C] later', skip: true },
    { type: 'test:pass', name: '[X-010] a neighbor with a longer id' },
  ].map(event => JSON.stringify(event)).join('\n');
  assert.deepEqual(Object.fromEntries(Object.entries(caseResults(list, events)).map(([id, value]) => [id, value.status])),
    { 'C-A': 'passed', 'C-B': 'failed', 'C-C': 'skipped', 'C-D': 'missing', 'X-01': 'missing' });
});

async function harness(t, commandRunner) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo factory cases-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const store = new JobStore(root); await store.init();
  const job = await store.create({ brief: { workingName: 'Cases', mustHaves: ['Upload photos'], acceptanceScenarios: ['Oversized uploads are refused'] }, transcript: [{ role: 'user', content: 'x' }], provider: 'fixture', sdlc: 'single' });
  const factory = new SoloFactory({ store, commandRunner });
  const manifest = { commands: { test: ['node', '-e', '0'], build: ['node', '-e', '1;'] } };
  const item = requirement();
  return { root, app: store.appDir(job.id), job, verify: (proofs = [item]) => factory.verify(job, manifest, undefined, { includeInstall: false, proofs }) };
}

test('a cased proof gate fails, naming the cases that did not pass, even when the command exits 0', async t => {
  let passing = [];
  const seen = [];
  const env = await harness(t, async ({ args, env = {} }) => {
    seen.push([args.join(' '), env.NODE_OPTIONS ?? null]);
    const destination = env.SOLOFACTORY_CASE_EVENTS;
    if (destination) await writeFile(destination, passing.map(id => JSON.stringify({ type: 'test:pass', name: `[${id}] test` })).join('\n'));
    return { code: 0, output: 'ok' };
  });
  const silent = await env.verify();
  assert.equal(silent.code, 'quality_gate_failed');
  assert.match(silent.message, /recorded no test events for its cases; cased proofs must run under node:test/);
  passing = ['UP-API-OK'];
  const one = await env.verify();
  assert.equal(one.message, 'proof-UPLOAD-LIMITS cases did not pass: UP-API-BIG missing, UP-UI-BIG missing.');
  assert.deepEqual(Object.fromEntries(Object.entries(one.details.cases).map(([id, value]) => [id, value.status])), { 'UP-API-OK': 'passed', 'UP-API-BIG': 'missing', 'UP-UI-BIG': 'missing' });
  passing = ['UP-API-OK', 'UP-API-BIG', 'UP-UI-BIG'];
  assert.equal(await env.verify(), null);
  // Only the cased gate gets the reporter; a requirement without cases still passes on its exit code.
  assert.ok(seen.filter(([command]) => command === '-e 0').every(([, options]) => options === null));
  const { cases: _, ...plain } = requirement();
  seen.length = 0;
  assert.equal(await env.verify([plain]), null);
  assert.ok(seen.every(([, options]) => options === null));
});

test('the factory reporter reads real node:test results: a skipped case fails the gate, all passing cases pass it', async t => {
  const env = await harness(t, undefined);
  const body = skip => `import test from 'node:test';
test('[UP-API-OK] accepts a small photo', () => {});
test('[UP-API-BIG] refuses a large photo', ${skip ? '{ skip: true }, ' : ''}() => {});
test('[UP-UI-BIG] shows the size error', () => {});
`;
  await writeFile(path.join(env.app, 'test-upload.test.mjs'), body(true));
  const item = { ...requirement(), proof: { command: ['node', '--test', 'test-upload.test.mjs'], expect: 'every case passes' } };
  const skipped = await env.verify([item]);
  assert.equal(skipped?.message, 'proof-UPLOAD-LIMITS cases did not pass: UP-API-BIG skipped.');
  await writeFile(path.join(env.app, 'test-upload.test.mjs'), body(false));
  assert.equal(await env.verify([item]), null);
  assert.equal(env.job.caseResults['UP-API-BIG'].status, 'passed');
});

test('a test that spawns its own node:test process does not erase the gate\'s case events', async t => {
  const env = await harness(t, undefined);
  await writeFile(path.join(env.app, 'test-upload.test.mjs'), `import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('[UP-API-OK] accepts a small photo', () => new Promise(done => setTimeout(done, 300)));
test('[UP-API-BIG] refuses a large photo', () => new Promise(done => setTimeout(done, 300)));
test('[UP-UI-BIG] shows the size error', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', "import test from 'node:test'; test('inner', () => {});"], { env: { ...process.env, NODE_TEST_CONTEXT: '' } });
});
`);
  const item = { ...requirement(), proof: { command: ['node', '--test', 'test-upload.test.mjs'], expect: 'every case passes' } };
  assert.equal(await env.verify([item]), null);
});

test('the feature builder is told how cases are proved', () => {
  const prompt = featureBuildPrompt(plan([requirement()]).slices[0], { owned: [], planDigest: 'digest' });
  assert.match(prompt, /one node:test per case\nwhose name contains \[CASE-ID\]/);
  assert.match(prompt, /without a --test-reporter flag of its own/);
  assert.match(prompt, /test script is plain "node --test" with no directory argument/);
  assert.match(prompt, /a script that prints its own\nok\/fail lines records nothing/);
  assert.match(prompt, /do not read \.factory\/slices\.json or other features' plans/);
  assert.match(prompt, /every form control you render an accessible name/);
});

test('only the last feature builder is asked for the README', () => {
  const slice = plan([requirement()]).slices[0];
  assert.match(featureBuildPrompt(slice, { owned: [], planDigest: 'digest', last: true }), /README\.md/);
  assert.doesNotMatch(featureBuildPrompt(slice, { owned: [], planDigest: 'digest' }), /README/);
});

test('the feature builder sees each shared proof command once, and every requirement and case still', () => {
  const long = { command: ['node', '--test', ...Array.from({ length: 40 }, (_, n) => `test/integration/case-${n}.test.mjs`)], expect: 'every case passes' };
  const other = { command: ['node', '--test', 'test/other.test.mjs'], expect: 'passes' };
  const slice = plan([requirement({ proof: long }), requirement({ id: 'R2', proof: long, cases: undefined }), requirement({ id: 'R3', proof: long, cases: undefined }), requirement({ id: 'R4', proof: other, cases: undefined })]).slices[0];
  const prompt = featureBuildPrompt(slice, { owned: [], planDigest: 'digest' });
  assert.equal(prompt.split('case-39.test.mjs').length - 1, 1, 'a shared command appears once');
  assert.equal(prompt.split('test/other.test.mjs').length - 1, 1);
  assert.equal((prompt.match(/"command": "C1"/g) ?? []).length, 3); assert.equal((prompt.match(/"command": "C2"/g) ?? []).length, 1);
  for (const id of ['UPLOAD-LIMITS', 'R2', 'R3', 'R4', ...cases().map(entry => entry.id)]) assert.match(prompt, new RegExp(`"${id}"`));
  assert.equal(slice.acceptance[0].proof.command, long.command, 'the plan itself is unchanged');
});

// Seen live: a 52-case feature made 210K-character build and review prompts, over the 200K cap.
test('an oversized feature is read from its file instead of being inlined in either prompt', () => {
  const slice = plan([requirement({ behavior: 'x'.repeat(70_000) })]).slices[0];
  for (const prompt of [featureBuildPrompt(slice, { owned: [], planDigest: 'digest' }), featureReviewPrompt(slice)]) {
    assert.ok(prompt.length < 20_000, String(prompt.length));
    assert.match(prompt, /read \.factory\/logs\/feature\.json/);
  }
  assert.match(featureBuildPrompt(plan([requirement()]).slices[0], { owned: [], planDigest: 'digest' }), /"UPLOAD-LIMITS"/);
});

// Run 4f2dd1cf: most of 46 blocked feature reviews were proofs asserting only part of their case text.
// Builder, feature repair and reviewer must read the same bar, so it is one shared string.
test('the builder and feature repair see the exact bar the feature reviewer applies', () => {
  const slice = plan([requirement()]).slices[0];
  for (const prompt of [featureBuildPrompt(slice, { owned: [], planDigest: 'digest' }), featureReviewPrompt(slice), repairPrompt('.factory/last-failure-1.txt', slice)]) {
    assert.ok(prompt.includes(REVIEW_BAR));
  }
  assert.match(REVIEW_BAR, /every clause/);
  assert.match(featureBuildPrompt(slice, { owned: [], planDigest: 'digest' }), /map each clause/);
  assert.ok(!repairPrompt('.factory/last-failure-1.txt').includes(REVIEW_BAR), 'non-feature repairs have no case bar');
});

// Keeping an id is a promise that the obligation still asserts the same thing; a rewrite must be a superseding case.
test('a kept obligation keeps its behavior, expected result, proof command and cases', () => {
  const base = plan([requirement()]);
  assert.doesNotThrow(() => assertConsolidation(plan([requirement()]), base));
  assert.throws(() => assertConsolidation(plan([requirement({ behavior: 'Uploads accept photos' })]), base), /kept UPLOAD-LIMITS changes its behavior; supersede it with a case instead/);
  assert.throws(() => assertConsolidation(plan([requirement({ proof: { ...proof, command: ['node', '--test', 'test/smoke.test.mjs'], expect: 'passes' } })]), base), /changes its expected result, proof command/);
  assert.throws(() => assertConsolidation(plan([requirement({ cases: cases().slice(0, 2) })]), base), /drops or changes cases UP-UI-BIG/);
  assert.throws(() => assertConsolidation(plan([requirement({ cases: cases().map(c => c.id === 'UP-API-BIG' ? { ...c, expect: '400' } : c) })]), base), /drops or changes cases UP-API-BIG/);
});

// Output of a cased gate on Linux / WSL with Node 22 when the reporter destination was /dev/null:
// every test passed, then the reporter stream's fsync failed and Node exited 1.
const FSYNC_CRASH = `✔ [UP-API-OK] accepts a small photo (0.9ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 129.66
node:events:497
      throw er; // Unhandled 'error' event
      ^

Error: EINVAL: invalid argument, fsync
Emitted 'error' event on WriteStream instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
    at emitErrorCloseNT (node:internal/streams/destroy:129:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:89:21) {
  errno: -22,
  code: 'EINVAL',
  syscall: 'fsync'
}

Node.js v22.22.1`;

test('cased gates never send the reporter to /dev/null, and quote its paths for NODE_OPTIONS', async t => {
  let options = null;
  const env = await harness(t, async ({ env = {} }) => {
    if (!env.SOLOFACTORY_CASE_EVENTS) return { code: 0, output: 'ok' };
    options = env.NODE_OPTIONS;
    await writeFile(env.SOLOFACTORY_CASE_EVENTS, ['UP-API-OK', 'UP-API-BIG', 'UP-UI-BIG'].map(id => JSON.stringify({ type: 'test:pass', name: `[${id}] test` })).join('\n'));
    return { code: 0, output: 'ok' };
  });
  assert.equal(await env.verify(), null);
  assert.doesNotMatch(options, /dev\/null/);
  const destination = options.match(/--test-reporter-destination=("(?:[^"\\]|\\.)*")/)?.[1];
  assert.ok(destination, options);
  // The harness root has a space in it, so an unquoted path would split.
  assert.ok(JSON.parse(destination).startsWith(env.root), destination);
});

test('a NODE_OPTIONS path keeps its spaces, backslashes and quotes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solo factory paths-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  // A backslash is a separator on Windows and a legal name character elsewhere; either way Node must see it.
  const dir = path.join(root, process.platform === 'win32' ? 'a b' : 'a\\b "c"');
  await mkdir(dir);
  const file = path.join(dir, 'probe.cjs');
  await writeFile(file, 'process.stdout.write("loaded")');
  assert.equal(nodeOptionPath('C:\\Users\\x y\\r.mjs'), '"C:\\\\Users\\\\x y\\\\r.mjs"');
  const out = execFileSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: `--require=${nodeOptionPath(file)}` }, encoding: 'utf8' });
  assert.equal(out, 'loaded');
});

test('a Node crash after every test passed is told apart from a failing test', () => {
  assert.equal(runnerCrash(FSYNC_CRASH), 'Error: EINVAL: invalid argument, fsync');
  assert.equal(runnerCrash(FSYNC_CRASH.replace('ℹ fail 0', 'ℹ fail 1')), null, 'a failed test is a real failure');
  assert.equal(runnerCrash(FSYNC_CRASH.replace('ℹ pass 3', 'ℹ pass 0')), null, 'nothing passed');
  assert.equal(runnerCrash(FSYNC_CRASH.replace('(node:internal/streams/destroy:170:8)', '(file:///app/server.mjs:12:3)')), null, 'an error from the app\'s own code is the app\'s');
  assert.equal(runnerCrash('ℹ pass 3\nℹ fail 0\nℹ duration_ms 5\nsh: 1: lint: not found'), null, 'a later step failing without a Node stack');
  assert.equal(runnerCrash(''), null);
});

test('a cased gate whose runner crashed after its tests passed parks without a repair turn', async t => {
  const env = await harness(t, async ({ env = {} }) => {
    if (!env.SOLOFACTORY_CASE_EVENTS) return { code: 0, output: 'ok' };
    await writeFile(env.SOLOFACTORY_CASE_EVENTS, ['UP-API-OK', 'UP-API-BIG', 'UP-UI-BIG'].map(id => JSON.stringify({ type: 'test:pass', name: `[${id}] test` })).join('\n'));
    return { code: 1, output: FSYNC_CRASH };
  });
  const failure = await env.verify();
  assert.equal(failure.code, 'gate_infrastructure');
  assert.match(failure.message, /every test passed, but the test runner then crashed \(Error: EINVAL: invalid argument, fsync\), so no repair turn ran/);
  // The same exit code with a failed case is still the app's failure.
  const real = await harness(t, async ({ env = {} }) => {
    if (!env.SOLOFACTORY_CASE_EVENTS) return { code: 0, output: 'ok' };
    await writeFile(env.SOLOFACTORY_CASE_EVENTS, JSON.stringify({ type: 'test:fail', name: '[UP-API-OK] test' }));
    return { code: 1, output: FSYNC_CRASH };
  });
  assert.equal((await real.verify()).code, 'quality_gate_failed');
});

test('the specification, the planner and the first feature builder get the same npm test script rule', () => {
  assert.ok(featurePlanPrompt().includes(TEST_SCRIPT_RULE));
  assert.ok(featurePlanPrompt().includes(OWN_FILES_RULE) && featurePlanPrompt({ followOn: true }).includes(OWN_FILES_RULE));
  assert.ok(!featurePlanPrompt({ followOn: true }).includes(TEST_SCRIPT_RULE));
  assert.ok(specificationPrompt(true).includes(TEST_SCRIPT_RULE) && !specificationPrompt(true, { followOn: true }).includes(TEST_SCRIPT_RULE));
  // Planned runs (planVersion 2) call specificationPrompt(false); PLAN.md must still get the rule.
  assert.ok(specificationPrompt(false).includes(TEST_SCRIPT_RULE) && !specificationPrompt(false, { followOn: true }).includes(TEST_SCRIPT_RULE));
  assert.ok(featureBuildPrompt(plan([requirement()]).slices[0], { owned: [], planDigest: 'digest' }).includes(TEST_SCRIPT_RULE));
});
