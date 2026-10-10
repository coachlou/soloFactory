import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { contractDigest, originalChecks, preparePlanReview, runInputs, sourceSet, validatePlanReview, validateReview } from './review.mjs';
import { failedIntegrationProofs, pendingProofFailure, validateFeaturePlan, validateSlicePlan } from './wbs.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// v2 repair features close checks; v1 recovery slices (older ready phases) listed them as checks.
const sliceChecks = slice => slice.closes ?? slice.checks;

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
  if (raw?.version === 2) {
    if (raw.requestId !== request.id) throw new Error('Repair plan does not match its request.');
    // A dependency on an already built feature is satisfied; only ids in this plan are validated.
    const built = new Set(request.completed ?? []);
    raw = { ...raw, slices: raw.slices?.map(slice => Array.isArray(slice?.dependsOn) ? { ...slice, dependsOn: slice.dependsOn.filter(dep => !built.has(dep)) } : slice) };
    return { ...validateFeaturePlan(raw, { jobId: request.jobId, contractDigest: request.contractDigest, checks: request.checks, sources: request.sources.map(item => item.path) }), requestId: request.id };
  }
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

const PLAN_SCHEMA = `{version:2,jobId,requestId,contractDigest (copied from the request),compatibility:[{subject,status:"verified",evidence}],slices:[{id (uppercase letters/digits/hyphens),title,objective,demo,dependsOn:[earlier feature ids],closes:[unfinished check ids this feature fully closes],acceptance:[{id,behavior (one concrete observable behavior),refs:[check ids],sources:[{path (one of request.sources),locator (section, heading, line or element)}],proof:{command:["npm"|"node"|"npx",...args],expect,pending?:"integration"}}]}]}`;

function repairPlanPrompt(planFile, request) {
  return `Prepare a repair plan ONLY. Do not implement, reset, narrow scope, install, or deploy. Preserve all source, user data, the frozen contract and previous evidence. Read .factory/REVIEW.md, the existing app and tests, and EVERY file in request.sources (frozen contract plus attached specs, mockups and prototype handoffs). Investigate model/tool compatibility read-only if needed.
Write ONLY ${planFile} as JSON: ${PLAN_SCHEMA}.
Every unfinished check has exactly one closing feature. A broad MH/SC summary is not enough: carry each detailed obligation the sources state for that gap (fields, states, limits, error cases, layout, copy) as its own acceptance item citing the source path and locator. Each proof is an executable test of real behavior. Preserve already passing behavior and completed features; no new walking skeleton. Use small dependency-ordered features. The plan is reviewed against the sources before execution.
Request:
${JSON.stringify(request, null, 2)}`;
}

function repairPlanAuditPrompt(planFile) {
  return `You are the independent repair-plan reviewer. No repair has started. Read .factory/plan-review-request.json (the unfinished checks, review findings and the authoritative sources), .factory/REVIEW.md, EVERY source file it lists, the existing app and tests, and ${planFile}.
Do NOT modify ${planFile} or any file except .factory/plan-review-result.json. Editing the plan voids your verdict. Write:
{ "version": 1, "jobId", "token", "contractDigest", "planDigest" copied exactly from plan-review-request.json, "verdict": "approve" | "blocked", "blockers": ["<concrete problem>"] }
Block when any detailed obligation a source states for an unfinished check is missing from the plan, an obligation cites the wrong source or locator, a finding is not addressed, a proof is not an executable test of real behavior, negative/failure cases are missing, a feature is too large to verify alone, or a required model, package or tool is unverified. Approve only a plan you would execute as written.`;
}

function repairCorrectionPrompt(planFile, blockers) {
  return `You are correcting the repair plan after a blocked review. Read the request in .factory/plan-review-request.json, every source it lists and ${planFile}. Rewrite ONLY ${planFile} (same schema, jobId, requestId and contractDigest) to resolve every blocker without narrowing, waiving or dropping a requirement. Do not write code.
Blockers:
${blockers.map(item => `- ${item}`).join('\n')}`;
}

// The plan-correction budget belongs to an input fingerprint. Every preparation since the last executed
// plan (retries, feedback revisions, a return to earlier inputs) shares the corrections already spent
// on its fingerprint; only revised inputs or new evidence from an executed plan start fresh.
function spentCorrections(history = [], sourcesDigest) {
  let spent = 0;
  for (const phase of [...history].reverse()) {
    if (!['planning', 'plan_failed', 'ready'].includes(phase.status)) break;
    if (phase.request?.sourcesDigest === sourcesDigest) spent = Math.max(spent, phase.corrections ?? 0);
  }
  return spent;
}

export async function planFeatureRecovery(factory, id, signal, guidance = '') {
  let job = await factory.store.read(id);
  const appDir = factory.store.appDir();
  try {
    if (!['failed', 'interrupted', 'paused'].includes(job.state) || job.dismissed || (job.recoveryPhase && !['planning', 'plan_failed', 'ready', 'running', 'built'].includes(job.recoveryPhase.status))) throw new Error('Repair planning requires an unresolved parked run.');
    const prior = job.recoveryPhase;
    // Which review stopped the run decides the gaps:
    // - a not-yet-run plan is revised against its own review and gaps;
    // - a parked running phase or a planned run stopped on a scoped feature review: the plan's unclosed checks;
    // - otherwise the final whole-app review: its failed checks.
    // Approved inputs that changed since approval come first: the old review no longer describes them.
    const executed = ['running', 'built'].includes(prior?.status);
    const approvedSources = prior ? prior.request.sources : job.approvedPlan?.sources;
    const now = approvedSources ? await sourceSet(appDir, runInputs(job)) : null;
    if (approvedSources && digest(now) !== digest(approvedSources)) return await replanForInputs(factory, job, signal, guidance, { prior, executed, approvedSources, now });
    // A deterministic integration proof failed: its obligation is the finding; no reviewer rejection exists to bind.
    const failedProof = pendingProofFailure(job);
    if (failedProof) return await replanForProof(factory, job, signal, guidance, { prior, executed, failedProof });
    // Revising a stale-input plan that was never executed reuses its assessment; there is still no review to bind.
    if (prior && !executed && prior.request.review === null) return await draftRepairPlan(factory, job, signal, { ...prior.request, id: randomUUID(), guidance, baseline: await sourceBaseline(factory.store), priorPlan: prior.plan ?? prior.request.priorPlan }, prior);
    const revising = ['planning', 'plan_failed', 'ready'].includes(prior?.status) && prior.request.review;
    const featurePlan = prior?.status === 'running' ? { plan: prior.plan, done: prior.done, checks: prior.request.checks, review: prior.cursor?.reviewRequest ?? prior.lastReview }
      : !prior && job.approvedPlan && job.featureCursor?.reviewRequest ? { plan: job.approvedPlan.plan, done: job.sliceDone ?? [], checks: originalChecks(job.brief), review: job.featureCursor.reviewRequest }
      : null;
    const reviewRequest = revising ? prior.request.review : featurePlan ? featurePlan.review : job.reviewRequest;
    let findings;
    try { await validateReview(appDir, reviewRequest); }
    catch (error) { findings = error.details; }
    if (!findings?.failedChecks?.length) throw new Error('Repair planning requires a matching review with unfinished checks.');
    const frozen = await contractDigest(appDir);
    if (frozen !== (job.reviewContractDigest ?? job.approvedPlan?.contractDigest)) throw new Error('Frozen contract changed; recovery cannot waive or replace it.');
    const scoped = findings.failedChecks.map(check => `${check.id} (${check.status}): ${check.text}${check.reason ? ` — ${check.reason}` : ''}`);
    let checks, blockers;
    if (revising) ({ checks, blockers } = prior.request);
    else if (featurePlan) {
      const closed = new Set(featurePlan.plan.slices.filter(slice => featurePlan.done.includes(slice.id)).flatMap(sliceChecks));
      checks = featurePlan.checks.filter(check => !closed.has(check.id));
      blockers = [...findings.blockers, ...scoped];
    } else ({ failedChecks: checks, blockers } = findings);
    const sources = await sourceSet(appDir, runInputs(job));
    const request = { id: randomUUID(), jobId: id, contractDigest: frozen, review: reviewRequest, reviewToken: reviewRequest.token, checks, blockers, sources, sourcesDigest: digest(sources), baseline: await sourceBaseline(factory.store), guidance, priorPlan: prior?.plan ?? featurePlan?.plan ?? null, completed: prior?.done ?? featurePlan?.done ?? [] };
    return await draftRepairPlan(factory, job, signal, request, prior);
  } catch (error) { return factory.fail(id, signal, error); }
}

// Inputs changed after approval: assess which verified features cited a changed file and replan
// the unfinished and reopened checks against the current inputs. Completed work is preserved.
async function replanForInputs(factory, job, signal, guidance, { prior, executed, approvedSources, now }) {
  const appDir = factory.store.appDir();
  const frozen = await contractDigest(appDir);
  if (frozen !== (job.reviewContractDigest ?? job.approvedPlan?.contractDigest ?? prior?.request.contractDigest)) throw new Error('Frozen contract changed; recovery cannot waive or replace it.');
  const before = new Map(approvedSources.map(item => [item.path, item.sha256]));
  const changed = now.filter(item => before.get(item.path) !== item.sha256).map(item => item.path);
  const plan = executed ? prior.plan : prior ? prior.request.priorPlan : job.approvedPlan.plan;
  const done = executed ? prior.done : prior ? prior.request.completed : job.sliceDone ?? [];
  const universe = prior?.request.checks ?? originalChecks(job.brief);
  const verified = (plan?.slices ?? []).filter(slice => done.includes(slice.id));
  const cites = slice => (slice.acceptance ?? []).some(item => item.sources?.some(ref => changed.includes(ref.path)));
  // ponytail: a changed input the plan never cited could affect any verified feature, so all of them reopen.
  const uncited = changed.some(file => !(plan?.slices ?? []).some(slice => slice.acceptance?.some(item => item.sources?.some(ref => ref.path === file))));
  const reopenedSlices = verified.filter(slice => uncited || cites(slice));
  const reopened = new Set(reopenedSlices.flatMap(sliceChecks));
  // A reopened feature's outstanding proofs are superseded: its replacement re-proves them.
  for (const entry of job.outstandingProofs ?? []) {
    if (entry.status !== 'superseded' && entry.planDigest === digest(plan) && reopenedSlices.some(slice => slice.id === entry.feature)) Object.assign(entry, { status: 'superseded', reason: `${entry.feature} was reopened after ${changed.join(', ')} changed` });
  }
  const closed = new Set(verified.flatMap(sliceChecks).filter(check => !reopened.has(check)));
  const known = [...universe, ...originalChecks(job.brief)];
  const ids = [...new Set([...universe.map(check => check.id), ...reopened])].filter(check => !closed.has(check));
  const checks = ids.map(check => known.find(item => item.id === check));
  if (!checks.length) throw new Error('No unfinished checks remain to replan against the changed inputs.');
  const blockers = [
    ...changed.map(file => `${file} ${before.has(file) ? (now.find(item => item.path === file).sha256 === 'deleted' ? 'was removed' : 'changed') : 'was added'} after the plan was approved; re-derive its obligations from the current file.`),
    ...[...reopened].map(check => `${check} was closed by a verified feature that relied on a changed input; prove it again against the current inputs.`),
  ];
  const request = { id: randomUUID(), jobId: job.id, contractDigest: frozen, review: null, reviewToken: null, inputsChanged: changed, checks, blockers, sources: now, sourcesDigest: digest(now), baseline: await sourceBaseline(factory.store), guidance, priorPlan: plan ?? null, completed: done };
  return draftRepairPlan(factory, job, signal, request, prior);
}

// The failed proof's obligation, command and output stand in for review findings; the checks it
// supports are the gaps. The proof stays outstanding and gates the repaired app again.
async function replanForProof(factory, job, signal, guidance, { prior, executed, failedProof }) {
  const appDir = factory.store.appDir();
  const frozen = await contractDigest(appDir);
  if (frozen !== (job.reviewContractDigest ?? job.approvedPlan?.contractDigest ?? prior?.request.contractDigest)) throw new Error('Frozen contract changed; recovery cannot waive or replace it.');
  const plan = executed ? prior.plan : job.approvedPlan?.plan ?? null;
  const done = executed ? prior.done : job.sliceDone ?? [];
  const known = [...(prior?.request.checks ?? []), ...originalChecks(job.brief)];
  const failed = failedIntegrationProofs(job);
  const targets = failed.flatMap(entry => entry.refs.length ? entry.refs.map(id => known.find(check => check.id === id) ?? { id, text: entry.obligation.behavior })
    : [{ id: entry.key, text: `${entry.obligation.behavior} (source: ${(entry.obligation.sources ?? []).map(ref => `${ref.path} ${ref.locator}`).join('; ')}) (proof: ${entry.obligation.proof.command.join(' ')} → ${entry.obligation.proof.expect})` }]);
  const checks = [...new Map(targets.map(check => [check.id, check])).values()];
  const { output = '' } = job.error.details ?? {};
  const blockers = failed.map(({ obligation, feature }) => `${feature}/${obligation.id} failed its integration proof: ${obligation.behavior}\nProof command: ${obligation.proof.command.join(' ')} — expected: ${obligation.proof.expect}${output ? `\nProof output (tail):\n${String(output).slice(-2000)}` : ''}`);
  const sources = await sourceSet(appDir, runInputs(job));
  const request = { id: randomUUID(), jobId: job.id, contractDigest: frozen, review: null, reviewToken: null, failedProof: failedProof.key, checks, blockers, sources, sourcesDigest: digest(sources), baseline: await sourceBaseline(factory.store), guidance, priorPlan: plan, completed: done };
  return draftRepairPlan(factory, job, signal, request, prior);
}

async function draftRepairPlan(factory, job, signal, request, prior) {
  const id = job.id;
  const appDir = factory.store.appDir();
  const { checks, blockers, sources } = request;
  const frozen = request.contractDigest;
  try {
    const planFile = `.factory/recovery-plan-${request.id}.json`;
    await archiveReview(factory, job, `recovery-${request.id}-source`);
    await writeFile(path.join(factory.store.jobDir(id), `recovery-${request.id}-request.json`), JSON.stringify(request, null, 2));
    // Stale-input plans have no current review to bind; review-backed plans bind the source verdict.
    const sourceReport = request.review ? JSON.parse(await readFile(path.join(appDir, '.factory/review-result.json'), 'utf8')) : null;
    if (prior) { job.recoveryPhaseHistory ??= []; job.recoveryPhaseHistory.push(prior); }
    const corrections = spentCorrections(job.recoveryPhaseHistory, request.sourcesDigest);
    job.recoveryPhase = { id: request.id, status: 'planning', request, sourceReportDigest: sourceReport && digest(sourceReport), planFile, done: [], index: 0, stats: {}, reviews: 0, corrections };
    const phase = job.recoveryPhase;
    job.error = null; job.failedState = null; job.recovery = null;
    job = await factory.stage(job, 'specifying', 'Preparing a repair plan from preserved files');
    const guard = async () => {
      if (await contractDigest(appDir) !== frozen || await sourceBaseline(factory.store) !== request.baseline || digest(await sourceSet(appDir, runInputs(job))) !== request.sourcesDigest) throw new Error('A planning turn changed the preserved source, specs or frozen contract; execution is blocked.');
    };
    const readPlan = async () => {
      try { return validateRecoveryPlan(JSON.parse(await readFile(path.join(appDir, planFile), 'utf8')), request); }
      catch (error) { return error; }
    };
    await factory.invoke(job, `recovery-plan-${request.id}`, repairPlanPrompt(planFile, request), signal);
    await guard();
    let plan = await readPlan();
    // Same structured gate as feature planning: a separate reviewer approves this exact plan, or it is corrected.
    for (;;) {
      let planBlockers;
      if (plan instanceof Error) planBlockers = [plan.message];
      else {
        const planDigest = digest(plan);
        const review = await preparePlanReview(appDir, job, planDigest, { kind: 'repair', requestId: request.id, planFile, checks, findings: blockers, sources });
        phase.reviews += 1;
        await factory.store.writeState(job);
        await factory.invoke(job, `recovery-plan-review-${request.id}-${phase.reviews}`, repairPlanAuditPrompt(planFile), signal);
        await guard();
        const after = await readPlan();
        if (after instanceof Error || digest(after) !== planDigest) throw new Error('The repair plan reviewer changed the plan, so its verdict cannot approve it.');
        try {
          await validatePlanReview(appDir, review);
          phase.planReview = { token: review.token, planDigest };
          break;
        } catch (error) {
          if (!error.details?.blockers) throw error;
          planBlockers = error.details.blockers.length ? error.details.blockers : [error.message];
        }
      }
      phase.planBlockers = planBlockers;
      await factory.emit(id, { type: 'plan.blocked', state: job.state, message: planBlockers[0] });
      if (phase.corrections >= factory.maxRepairs) throw Object.assign(new Error(`The repair plan is still blocked after ${phase.corrections} corrections: ${planBlockers[0]}`), { code: 'plan_blocked', details: { blockers: planBlockers } });
      phase.corrections += 1;
      await factory.store.writeState(job);
      await factory.invoke(job, `recovery-correction-${request.id}-${phase.corrections}`, repairCorrectionPrompt(planFile, planBlockers), signal);
      await guard();
      plan = await readPlan();
    }
    phase.plan = plan;
    phase.planDigest = digest(plan);
    phase.planBlockers = [];
    phase.status = 'ready';
    await writeFile(path.join(factory.store.jobDir(id), `recovery-${request.id}-approved-candidate.json`), JSON.stringify(plan, null, 2));
    job = await factory.stage(job, 'paused', 'Repair plan ready for approval');
    job.failedState = 'building';
    job.recovery = { canResume: false, title: 'Repair plan ready', summary: 'Review the remaining gaps, proposed features and proof checks, then approve to continue repairs. Existing files are preserved.', actions: ['Approve and continue repairs, or send feedback to prepare a revised plan.'], workspace: appDir, automaticRetry: 'No repair runs until the plan is approved.' };
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
  if (phase.plan.version === 2 && phase.planReview?.planDigest !== planDigest) throw new Error('Recovery approval does not match the reviewed plan.');
  if (await contractDigest(factory.store.appDir()) !== phase.request.contractDigest || await sourceBaseline(factory.store) !== phase.request.baseline) throw new Error('Recovery approval is stale; source or contract changed after planning.');
  if (phase.request.sourcesDigest && digest(await sourceSet(factory.store.appDir(), runInputs(job))) !== phase.request.sourcesDigest) throw new Error('Recovery approval is stale; specs or prototype inputs changed after planning.');
  if (phase.request.review === null) return; // stale-input plan: no review to bind
  const source = JSON.parse(await readFile(path.join(factory.store.appDir(), '.factory/review-result.json'), 'utf8'));
  if (source.token !== (phase.request.reviewToken ?? job.reviewRequest.token) || source.jobId !== job.id || digest(source) !== phase.sourceReportDigest) throw new Error('Recovery approval is stale; source review changed after planning.');
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
    const appDir = factory.store.appDir();
    // Fail closed when the approved plan's contract or inputs changed during execution or before resume.
    const assertCurrent = async () => {
      if (await contractDigest(appDir) !== phase.request.contractDigest) throw new Error('Frozen contract changed during feature recovery.');
      if (phase.request.sourcesDigest && digest(await sourceSet(appDir, runInputs(job))) !== phase.request.sourcesDigest) throw Object.assign(new Error('Specs or prototype inputs changed after the repair plan was approved; prepare a repair plan against the current inputs.'), { code: 'inputs_changed' });
    };
    for (let i = phase.index; i < phase.plan.slices.length; i++) {
      const slice = phase.plan.slices[i];
      await assertCurrent();
      if (!phase.cursor && phase.current === slice.id) {
        // Legacy phase parked mid-feature (before cursors): keep its budget and recheck the preserved
        // work instead of rebuilding. ponytail: attemptBefore reconstructed from the limit legacy set.
        phase.cursor = { id: slice.id, substage: 'checking', implementStarted: true, reviews: 0, startedAt: new Date().toISOString(), attemptBefore: Math.max(0, (job.repairBudgetLimit ?? job.attempt) - factory.maxRepairs), migrated: true };
        await factory.store.writeState(job);
      } else if (phase.cursor?.id !== slice.id) {
        // Persisted substage cursor: pause/resume continues exactly where the feature stopped.
        phase.cursor = { id: slice.id, substage: 'implementing', implementStarted: false, reviews: 0, startedAt: new Date().toISOString(), attemptBefore: job.attempt };
        phase.current = slice.id;
        job.repairBudgetLimit = Math.min(job.attempt + factory.maxRepairs, phase.totalRepairLimit);
        await factory.store.writeState(job);
      }
      const label = `recovery-${phase.id}-${slice.id}`;
      const owned = phase.request.checks.filter(c => sliceChecks(slice).includes(c.id));
      // v1 (legacy) slices carry prose acceptance; give each a stable check id for the scoped review.
      const feature = { ...slice, closes: sliceChecks(slice), acceptance: slice.acceptance.map((item, n) => typeof item === 'string' ? { id: `${slice.id}-A${n + 1}`, behavior: item, proof: null } : item) };
      job = await factory.proveFeature(job, feature, owned, `${i + 1}/${phase.plan.slices.length}`, signal, {
        cursor: phase.cursor, assertCurrent, planDigest: phase.planDigest, plan: phase.plan, planFile: phase.planFile,
        labels: { build: label, resume: `${label}-resume`, review: n => `${label}-review-${n}` },
      });
      phase.done.push(slice.id); phase.index = i + 1;
      phase.stats[slice.id] = { commit: phase.cursor.commit, reviews: phase.cursor.reviews, repairs: job.attempt - phase.cursor.attemptBefore, verifiedAt: new Date().toISOString() };
      phase.cursor = null;
      await factory.store.writeState(job);
      await factory.emit(id, { type: 'recovery.slice.completed', state: job.state, message: `Verified recovery feature ${slice.id}`, slice: slice.id });
    }
    await assertCurrent();
    phase.status = 'built'; phase.current = null;
    job.repairBudgetLimit = Math.min(job.attempt + factory.maxRepairs, phase.totalRepairLimit);
    await factory.store.writeState(job);
    job = await factory.reviewAndVerify(job, signal);
    return await factory.deployAndComplete(job, signal);
  } catch (error) { return factory.fail(id, signal, error); }
}
