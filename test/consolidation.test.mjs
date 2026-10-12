import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/store.mjs';
import { SoloFactory } from '../src/factory.mjs';
import { assertConsolidation, caseResults, validateFeaturePlan } from '../src/wbs.mjs';
import { featureBuildPrompt } from '../src/prompts.mjs';

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
  t.after(() => rm(root, { recursive: true, force: true }));
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
    const destination = env.NODE_OPTIONS?.match(/--test-reporter-destination="([^"]+)"/)?.[1];
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

test('the feature builder is told how cases are proved', () => {
  const prompt = featureBuildPrompt(plan([requirement()]).slices[0], { owned: [], planDigest: 'digest' });
  assert.match(prompt, /one node:test per case\nwhose name contains \[CASE-ID\]/);
  assert.match(prompt, /without a --test-reporter flag of its own/);
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
