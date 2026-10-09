import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { contractDigest, prepareReview, validateReview } from './review.mjs';
import { validateSlicePlan } from './wbs.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Source baseline only: never traverse owner data or ignored runtime/dependency trees.
// head:false is a feature candidate's identity: the same files stay the same candidate across gate commits.
export async function sourceBaseline(store, { head = true } = {}) {
  const root = await realpath(store.appDir());
  const names = await store.git('ls-files', '-z', '--cached', '--others', '--exclude-standard');
  const hash = createHash('sha256');
  if (head) hash.update(await store.git('rev-parse', 'HEAD'));
  for (const file of [...new Set(names.split('\0').filter(Boolean))].sort()) {
    if (/^(data|node_modules|dist|build|\.factory|\.solofactory)(\/|$)/.test(file) || file.startsWith('.aai/memory/')) continue;
    let actual;
    try { actual = await realpath(path.join(root, file)); }
    catch (error) { if (error.code === 'ENOENT') { hash.update(file).update('deleted'); continue; } throw error; }
    const relative = path.relative(root, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative) || /^(data|node_modules|\.git)(\/|$)/.test(relative)) throw new Error('Recovery source baseline cannot follow files outside the source tree.');
    hash.update(file).update('\0').update(await readFile(actual)).update('\0');
  }
  return hash.digest('hex');
}

export function validateRecoveryPlan(raw, request) {
  if (raw?.version !== 1 || raw.requestId !== request.id || raw.contractDigest !== request.contractDigest) throw new Error('Recovery plan does not match its request and frozen contract.');
  const normalized = validateSlicePlan(raw);
  if (normalized.slices.length > 30) throw new Error('Recovery is limited to 30 slices per approved plan.');
  const expected = new Set(request.checks.map(c => c.id));
  const seen = new Set();
  normalized.slices = normalized.slices.map((slice, i) => {
    const checks = raw.slices[i].checks;
    if (!Array.isArray(checks)) throw new Error(`Recovery slice ${slice.id} needs a checks array (empty for a prerequisite-only feature).`);
    for (const id of checks) {
      if (!expected.has(id) || seen.has(id)) throw new Error(`Unknown or multiply assigned recovery check ${id}.`);
      seen.add(id);
    }
    return { ...slice, checks: [...checks] };
  });
  const missing = [...expected].filter(id => !seen.has(id));
  if (missing.length) throw new Error(`Recovery plan omits unfinished checks: ${missing.join(', ')}`);
  return normalized;
}

export async function archiveReview(factory, job, label) {
  for (const file of ['review-request.json', 'review-result.json', 'REVIEW.md']) {
    const body = await readFile(path.join(factory.store.appDir(), '.factory', file)).catch(() => null);
    if (body) await writeFile(path.join(factory.store.jobDir(job.id), `${label}-${file}`), body);
  }
}

export async function planFeatureRecovery(factory, id, signal, guidance = '') {
  let job = await factory.store.read(id);
  try {
    if (!['failed', 'interrupted', 'paused'].includes(job.state) || job.dismissed || (job.recoveryPhase && !['planning', 'plan_failed', 'ready', 'built'].includes(job.recoveryPhase.status))) throw new Error('Feature recovery planning requires an unresolved parked run without an active recovery phase.');
    let findings;
    try { await validateReview(factory.store.appDir(), job.reviewRequest); }
    catch (error) { findings = error.details; }
    if (!findings?.failedChecks?.length) throw new Error('Feature recovery requires a matching review with unfinished checks.');
    const frozen = await contractDigest(factory.store.appDir());
    if (frozen !== job.reviewContractDigest) throw new Error('Frozen contract changed; recovery cannot waive or replace it.');
    const request = { id: randomUUID(), jobId: id, contractDigest: frozen, checks: findings.failedChecks, blockers: findings.blockers, baseline: await sourceBaseline(factory.store), guidance, priorPlan: job.recoveryPhase?.plan ?? null };
    const planFile = `.factory/recovery-plan-${request.id}.json`;
    await archiveReview(factory, job, `recovery-${request.id}-source`);
    await writeFile(path.join(factory.store.jobDir(id), `recovery-${request.id}-request.json`), JSON.stringify(request, null, 2));
    const sourceReport = JSON.parse(await readFile(path.join(factory.store.appDir(), '.factory/review-result.json'), 'utf8'));
    if (job.recoveryPhase) { job.recoveryPhaseHistory ??= []; job.recoveryPhaseHistory.push(job.recoveryPhase); }
    job.recoveryPhase = { id: request.id, status: 'planning', request, sourceReportDigest: digest(sourceReport), planFile, done: [], index: 0, stats: {} };
    job.error = null; job.failedState = null; job.recovery = null;
    job = await factory.stage(job, 'specifying', 'Planning feature recovery from preserved files');
    await factory.invoke(job, `recovery-plan-${request.id}`, `Prepare a feature recovery execution plan ONLY. Preserve all source, user data, frozen requirements, PRD, PLAN, ACCEPTANCE and previous evidence. Do not implement, reset, narrow scope, install, or deploy. Read .factory/REVIEW.md and the existing app. Investigate model/tool compatibility read-only if needed. Write ONLY ${planFile} as JSON: {version:1,requestId,contractDigest,slices:[{id (uppercase letters/digits/hyphens),title,objective,checks:[original MH/SC IDs],acceptance:[concrete behaviors and named executable tests to implement/run],dependsOn:[earlier slice IDs],demo}]}. Assign every unfinished check exactly once to its owning slice. A broad check may depend on earlier work, but its owning slice must verify the full check. Preserve already passing behavior. No new walking skeleton. Use small dependency-ordered feature slices; do not bundle the entire backlog into one slice. The plan is reviewed before execution. Request:\n${JSON.stringify(request, null, 2)}`, signal);
    if (await contractDigest(factory.store.appDir()) !== frozen || await sourceBaseline(factory.store) !== request.baseline) throw new Error('Planning changed the preserved source or frozen contract; execution is blocked.');
    const plan = validateRecoveryPlan(JSON.parse(await readFile(path.join(factory.store.appDir(), planFile), 'utf8')), request);
    job.recoveryPhase.plan = plan;
    job.recoveryPhase.planDigest = digest(plan);
    job.recoveryPhase.status = 'ready';
    await writeFile(path.join(factory.store.jobDir(id), `recovery-${request.id}-approved-candidate.json`), JSON.stringify(plan, null, 2));
    job = await factory.stage(job, 'paused', 'Feature recovery plan ready for approval');
    job.failedState = 'building';
    job.recovery = { canResume: false, title: 'Feature recovery plan ready', summary: 'Review the feature plan, then approve recovery. Existing files are preserved.', actions: ['Review and approve the feature recovery plan.'], workspace: factory.store.appDir(), automaticRetry: 'No execution until the plan is approved.' };
    await factory.store.writeState(job);
    return job;
  } catch (error) {
    if (job.recoveryPhase?.status === 'planning') { job.recoveryPhase.status = 'plan_failed'; await factory.store.writeState(job); }
    return factory.fail(id, signal, error);
  }
}

export async function validateRecoveryApproval(factory, job, planDigest) {
  const phase = job.recoveryPhase;
  if (phase?.status !== 'ready' || phase.planDigest !== planDigest || digest(phase.plan) !== planDigest) throw new Error('Recovery approval does not match the ready plan.');
  validateRecoveryPlan(phase.plan, phase.request);
  if (await contractDigest(factory.store.appDir()) !== phase.request.contractDigest || await sourceBaseline(factory.store) !== phase.request.baseline) throw new Error('Recovery approval is stale; source or contract changed after planning.');
  const source = JSON.parse(await readFile(path.join(factory.store.appDir(), '.factory/review-result.json'), 'utf8'));
  if (source.token !== job.reviewRequest.token || source.jobId !== job.id || digest(source) !== phase.sourceReportDigest) throw new Error('Recovery approval is stale; source review changed after planning.');
}

export async function runFeatureRecovery(factory, id, signal, approval = null) {
  let job = await factory.store.read(id);
  try {
    const phase = job.recoveryPhase;
    if (approval) {
      await validateRecoveryApproval(factory, job, approval);
      phase.status = 'running'; phase.approvedAt = new Date().toISOString();
      phase.totalRepairLimit = job.attempt + factory.maxRepairs * (phase.plan.slices.length + 1);
    } else if (phase?.status !== 'running') throw new Error('No approved recovery execution to resume.');
    job.error = null; job.failedState = null; job.recovery = null;
    await factory.store.writeState(job);
    for (let i = phase.index; i < phase.plan.slices.length; i++) {
      const slice = phase.plan.slices[i];
      if (await contractDigest(factory.store.appDir()) !== phase.request.contractDigest) throw new Error('Frozen contract changed during feature recovery.');
      if (phase.current !== slice.id) {
        phase.current = slice.id;
        job.repairBudgetLimit = Math.min(job.attempt + factory.maxRepairs, phase.totalRepairLimit);
        await factory.store.writeState(job);
      }
      const label = `recovery-${phase.id}-${slice.id}`;
      job = await factory.stage(job, 'building', `Recovery feature ${i + 1}/${phase.plan.slices.length}: ${slice.title}`);
      await factory.invoke(job, label, `Implement only this recovery feature in the preserved app. Read the frozen .factory contract. Earlier recovered features and existing behavior must remain working. Do not reset, waive scope, touch user data, or rewrite contract/plan files. Implement the named executable acceptance tests and real behavior; source-string assertions are not behavior tests. Run the relevant checks. Feature:\n${JSON.stringify(slice, null, 2)}\nOriginal requirements owned by this feature:\n${JSON.stringify(phase.request.checks.filter(c => slice.checks.includes(c.id)), null, 2)}`, signal);
      for (;;) {
        job = await factory.verifyWithRepairs(job, await factory.readManifest(factory.store.appDir()), signal, { includeInstall: true, slice });
        job = await factory.stage(job, 'reviewing', `Verifying recovery feature: ${slice.title}`);
        if (await contractDigest(factory.store.appDir()) !== phase.request.contractDigest) throw new Error('Frozen contract changed during feature implementation.');
        const owned = phase.request.checks.filter(c => slice.checks.includes(c.id)).map(c => `[${c.id}] ${c.text}`);
        const request = await prepareReview(factory.store.appDir(), { ...job, brief: { mustHaves: [...owned, ...slice.acceptance], acceptanceScenarios: [] } });
        await factory.invoke(job, `${label}-review-${job.attempt}`, `Review ONLY the recovery feature below against every check in .factory/review-request.json. Inspect and execute its acceptance tests. Preserve all files and frozen contract; do not implement unrelated features. Other planned recovery features may still be missing and must not block this scoped verdict. A pass requires actual behavior and executable evidence, not source strings or promised future tests. Write .factory/REVIEW.md and .factory/review-result.json: {version:1,jobId,token,contractDigest} copied from the request, verdict pass|blocked, blockers:[strings], checks:[{id,status:pass|failed|missing|unverified,evidence:[existing project-relative files],reason:string}]. Every request check is required. Feature:\n${JSON.stringify(slice, null, 2)}`, signal);
        await archiveReview(factory, job, `${label}-attempt-${job.attempt}`);
        try { await factory.requireReview({ ...job, reviewRequest: request }); }
        catch (error) { job = await factory.repair(job, error, signal, slice); continue; }
        const attempt = job.attempt;
        job = await factory.verifyWithRepairs(job, await factory.readManifest(factory.store.appDir()), signal, { includeInstall: false, slice });
        if (job.attempt !== attempt) continue;
        await factory.requireReview({ ...job, reviewRequest: request });
        break;
      }
      await factory.commit(job, `factory: recovery feature ${slice.id} verified`);
      phase.done.push(slice.id); phase.index = i + 1;
      phase.stats[slice.id] = { commit: await factory.store.git('rev-parse', 'HEAD'), verifiedAt: new Date().toISOString() };
      await factory.store.writeState(job);
      await factory.emit(id, { type: 'recovery.slice.completed', state: job.state, message: `Verified recovery feature ${slice.id}`, slice: slice.id });
    }
    phase.status = 'built'; phase.current = null;
    job.repairBudgetLimit = Math.min(job.attempt + factory.maxRepairs, phase.totalRepairLimit);
    await factory.store.writeState(job);
    job = await factory.reviewAndVerify(job, signal);
    return await factory.deployAndComplete(job, signal);
  } catch (error) { return factory.fail(id, signal, error); }
}
