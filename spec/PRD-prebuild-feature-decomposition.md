# PRD: Plan and verify feature slices before the first build

Status: proposed implementation handoff; no runtime changes made
Date: 2026-10-09
Owner: Lou D'Alo
Implementation target: SoloFactory dev repo

## 1. Problem and outcome

The household photo-library run `2026-10-07-4f2dd1cf` attempted a large specification through the single-build strategy. It produced a partial application. Stronger completion checks later exposed missing behavior, which required a separate 15-feature recovery plan inside the same preserved run. Recovery was necessary, but this decomposition should have happened before implementation.

New runs must first create a dependency-ordered feature plan covering every frozen must-have and acceptance scenario. No implementation worker may start until the controller validates that coverage and a fresh planning review approves the exact plan. Each feature must pass its executable checks and a scoped behavior review before the next feature starts. The full original contract still gates final deployment.

Small work can have one slice. Large work must not be compressed into an arbitrary six-slice limit. This is an execution change, not an invitation to add more product scope.

## 2. Findings from current code

These findings are from the current dev source, not assumptions about a future architecture.

| Concern | Current implementation | Required change |
|---|---|---|
| Strategy selection | `src/server.mjs` POST `/api/jobs` defaults omitted `sdlc` to `single`; `src/store.mjs` `create()` also defaults to `single`. `/api/config` lists single first. `public/app.js` renders that list with no stronger policy. | New runs use the planned slice path by default; the ordinary UI/API must not offer a bypass around its gates. |
| Existing decomposition | `src/prompts.mjs` asks for `slices.json` only when slice mode is selected. Its planning and plan-review prompts prescribe 2–6 slices. `src/factory.mjs` branches directly into a whole-app build for single mode. | Require a plan for all new runs; permit one coherent slice and more than six when justified by behavior and dependencies. |
| Coverage | `src/wbs.mjs` validates IDs, ordering, acceptance text, duplicate strings and presence of `SC-n` tags. It does not map `mustHaves`, executable proof, or full requirement ownership. Tags can claim coverage without delivering behavior. | Use typed original requirement references and testable proof obligations; inspect semantic adequacy through structured plan review. |
| Plan review | `reviewSlicePlan()` validates before/after a fresh worker turn, then sets `job.planReviewed = true`. The worker can rewrite the plan; no structured approval verdict or digest binds the boolean to the plan bytes. | Bind approval to the exact validated plan and frozen contract. A completed agent turn is not an approval. |
| Slice completion | `buildSlices()` runs the manifest gates, records stats, then appends `sliceDone`. Actual requirement review occurs after the whole plan through `finishFromBuild()`. | Scoped behavior review must pass before a slice enters `sliceDone` and dependents execute. |
| Mutable plan | `buildSlices()` reads the workspace plan again on resume. `contractDigest()` in `src/review.mjs` hashes requirements/PRD/PLAN/ACCEPTANCE, but not `slices.json`. | Freeze the approved plan separately and validate it on execution/resume; do not silently execute a changed plan. |
| Stronger recovery path | `src/feature-recovery.mjs` already validates typed original-check ownership, prerequisite-only slices, plan approval digests, scoped review, post-review checks, and bounded feature repair. | Reuse these proven mechanisms in normal construction rather than copy a second lifecycle. Keep recovery-specific gap selection/approval separate. |
| Resume cursor | Recovery returns through its feature loop when the phase is running. A pause before reviewing can re-enter implementation of the unfinished feature. Normal slices also track primarily an index. | Persist the current feature substage so a review pause resumes review of the preserved candidate. |
| Checkpoints | `factory.commit()` treats Git failure as an event and continues. A reported slice checkpoint can therefore be less reliable than its label suggests. | A feature is checkpointed only with an actual durable commit and verified source state; fail visibly when that cannot be established. |

Important limits: structural validation cannot prove that a feature works or that two differently worded criteria are equivalent. Planning review and executable behavior evidence supply that judgment. A source fingerprint cannot by itself identify which file change is authorized.

## 3. Product decisions

1. Keep one parent run per submitted brief. Features are sequential work units inside that run, not independent queued release jobs with separate specs. Retain project writer serialization and one final deployment.
2. Route all newly created runs through slice execution. A simple fix can use one slice with proportionate verification. Historical `single` runs retain their existing strategy, recovery files, and semantics.
3. Do not ask the owner to choose single versus slices. After brief approval, the factory prepares and audits the plan automatically. Show the plan and status in the dashboard. Park only for a real planning blocker or ambiguity that cannot be resolved without changing approved scope.
4. Do not add a second task graph, scheduler, or provider orchestration system. Extend `wbs.mjs`, `review.mjs`, and the existing controller; share normal/recovery feature verification where appropriate.
5. Preserve the original requirement wording. A broad original requirement may be split into smaller derived obligations, but those obligations must trace back to the complete original text and receive a designated closing feature.
6. Maintain bounded repairs: two corrections per plan, two repairs per feature, and two for final integration. Resuming never replenishes those budgets. The numbers are configuration policy, not permission for unlimited retries.
7. Keep final integration substantive. It must check the full frozen contract, prior passing behavior, required evidence, health and metrics; passed feature reviews do not waive it.

## 4. Proposed plan contract

Version `.factory/slices.json` for new plans. Retain a compatibility reader for historical plans; never rewrite an active legacy plan automatically.

A version-2 plan contains:

- `version`, `jobId`, and `contractDigest`.
- Ordered `slices` with stable IDs, title, observable objective, earlier dependencies, demo, and acceptance obligations.
- Explicit references to original `MH-n` and `SC-n` checks from the frozen brief. Use the same original-ID construction as full review; do not maintain competing numbering rules.
- Each original check has exactly one closing owner. A closing owner proves the whole requirement, including work supplied by dependencies. Supporting obligations may appear earlier and reference the same requirement without claiming to close it twice.
- An acceptance obligation has a stable local ID, expected behavior, original references, and a proof description identifying an executable test/command plus expected result. Commands are argument arrays governed by existing command policy, not arbitrary shell strings.
- A slice with no closing checks is allowed only as a named prerequisite with its own observable acceptance, executable proof, and a later dependent closing owner. Reject an orphan prerequisite.

Example: a people-search requirement can depend on person records, assignment/correction, and query evaluation. Earlier slices prove those increments. The closing slice proves the original all/any person-search behavior through a real workflow. Do not call it complete because a person table exists.

Validation must reject unknown IDs, missing ownership, duplicate closing owners, empty/fuzzy acceptance, malformed proof commands, forward dependencies/cycles, unreachable required work, and incomplete plan metadata. A valid one-slice plan is allowed. A safety maximum of 30 follows the existing recovery bound; exceeding it parks with a clear planning error rather than silently omitting or merging scope. Test filenames may be planned before they exist; require actual executable evidence at feature verification, not at prebuild validation.

## 5. Planning gate before implementation

Sequence:

1. Save immutable brief/transcript; generate PRD, PLAN and ACCEPTANCE without application mutations.
2. Build the canonical original-check registry and initial contract digest.
3. Generate and structurally validate the typed feature plan against that registry.
4. Invoke a fresh planning reviewer with the exact original contract and proposed plan. Require a structured verdict with job identity, fresh request token, reviewed plan digest, contract digest, and concrete blockers.
5. The reviewer checks complete scope, bounded/coherent features, prerequisite order, executable proof, negative/failure cases, and relevant model/tool compatibility. For a follow-on, inspect existing behavior and regression evidence before declaring work already delivered.
6. If blocked, run bounded planning correction and audit the revised plan again. Do not treat a reviewer's silent edit as approval of different bytes.
7. Freeze the approved normalized plan and digest in run-owned evidence. Before the first build and every resume, validate contract, plan, and approval binding. Only then start implementation.

Compatibility research must precede the slice that depends on an external model, native dependency, runtime, or deployment tool. Read-only checks may be enough. An unavailable required tool must become a specific blocker with preserved evidence; never invent a passing check or silently drop the requirement. No paid service fallback.

Limit allowed planning writes to the declared specification/plan/verdict artifacts. Compare source before/after and block execution on unexpected application mutations. Do not claim a hash alone is a write sandbox; use the existing CLI controls plus controller validation, preserve the unexpected changes for diagnosis, and do not reset owner work automatically.

## 6. Feature execution and proof

For each approved feature:

1. Start a scoped implementation turn with its obligations, original wording, dependencies, approved-plan digest, and prior verified state.
2. Run the manifest gates and planned feature proof through the existing command allowlist. Install only when appropriate; ensure dependency changes cannot leave stale installed packages for later slices.
3. Prepare a fresh scoped review request for this candidate. Require every feature obligation and owned original check to pass with real evidence. Future unrelated features must not block this verdict.
4. Scope the reviewer to review artifacts; detect unexpected implementation writes. Bind the verdict to the candidate source identity, not only the unchanged contract. If review/repair changes the candidate, invalidate the previous verdict.
5. Run deterministic gates again after a reviewer or repair alters source. Obtain a new review for the resulting candidate.
6. Persist reviewed candidate identity, evidence, durable commit, feature status and next cursor. Emit `slice.completed` and start dependents only after all of these succeed.

Keep the existing final full review/deployment protection. Do not mistake a summary file for complete evidence: required referenced captures/test outputs must exist, be nonempty, and belong to the reviewed candidate. Source-string tests or a worker's statement are insufficient evidence for user behavior.

Use distinct status names in state and UI: planned, implementing, checking, reviewing, verified, blocked. A test-green feature awaiting review is not verified.

## 7. Pause, resume, budgets and compatibility

Persist a feature cursor containing feature ID, substage, candidate identity, review request/verdict identity, proof results, repair counts and checkpoint commit. A safe pause must preserve that cursor.

- Pause before review: resume review of the same checked candidate, without another implementation turn unless source/evidence changed or review requires a repair.
- Interrupt during checking: rerun the necessary incomplete proof; do not skip checks based on an old status.
- Pause after verification: advance to the next feature once, with no duplicate completion event or replay.
- Contract/plan change: park as stale-plan approval; do not adopt changed scope or silently replan verified work.
- Exhausted feature budget: park with named findings, completed features retained, and no budget renewal through Resume.
- New follow-on briefs: plan increments against shipped state, preserve existing acceptance, and do not rebuild a walking skeleton unnecessarily.
- Historical runs and recovery phases: preserve their files and fields. Choose version-specific handling from persisted state, not from a new default or UI selection.

Do not bolt per-slice live deployment onto this change. A runnable/demoable slice can be checked by a disposable local test server; the deployment lifecycle remains separately governed.

## 8. Implementation map and order

| Order | Files/owner | Work |
|---|---|---|
| 1 | `src/wbs.mjs`, `src/review.mjs`, `test/wbs.test.mjs`, `test/review.test.mjs` | Typed versioned plan validation, one original-check registry, approval/candidate bindings, scoped evidence support. Keep pure plan validation separate from filesystem evidence validation. |
| 2 | `src/prompts.mjs`, `src/fixture-provider.mjs` | Always generate new typed plans; remove 2–6 compression; structured planning verdict/correction; explicit scope and executable proof. Deterministic fixtures must model blocked and passing verdicts. |
| 3 | `src/factory.mjs`, `src/feature-recovery.mjs`, `src/store.mjs` | Shared feature verification mechanics, enforce prebuild gate, durable substage cursor, candidate-bound review, checkpoint and repair limits. Preserve legacy dispatch and recovery-specific planning/approval. |
| 4 | `src/server.mjs`, `public/app.js`, `public/index.html` | New-run strategy policy, approved-plan visibility, feature progress and specific plan/feature blockers. Reject explicit new single-mode bypass or normalize through clearly documented compatibility behavior; never silently bypass. |
| 5 | `test/factory.test.mjs`, `test/feature-recovery.test.mjs`, `test/e2e.test.mjs` | Lifecycle, regression and real HTTP negative-path proof. |
| 6 | `SPEC.md`, `README.md`, `PROGRESS.md`, relevant user manual/drive instructions | Update the actual product contract and operator flow together. Verify `distro/APP_FILES` includes all new runtime artifacts and normal generation propagates changes. |

Implement in small validated increments. Do not rewrite the whole factory to share a handful of gate operations. Remove replaced normal-path logic instead of keeping two independent completion policies. Review current uncommitted model/profile changes before editing these files; those are prior authorized work, not scratch to discard.

## 9. Acceptance and regression matrix

1. A new brief submitted without `sdlc` produces a plan and cannot invoke a build before valid structured plan approval. UI defaults agree with API/store policy.
2. An explicit attempt to create a new single-mode run cannot skip that gate. Historical single runs still inspect/resume correctly.
3. A minimal one-feature brief can pass as one slice. A realistic many-feature brief can produce more than six without dropped requirements or horizontal mega-slices.
4. A plan that covers every SC but omits one MH is blocked with that MH named; unknown/duplicate owners and orphan prerequisites are also blocked.
5. Planning with unresolved compatibility, empty proof, malformed verdict, stale token, wrong digest, or application mutation starts zero implementation turns.
6. A plan reviewer that changes the plan cannot reuse a verdict for old bytes. Resume after plan edits fails closed.
7. A feature with passing tests/build but missing behavior or incomplete review evidence is not marked done; no dependent feature starts.
8. Review of one feature does not reject later planned omissions. Broad owned requirements still need full closing proof.
9. Candidate edits during review/repair force checks and fresh review. Missing referenced screenshots/evidence fail verification even when summary reports are green.
10. Pause after test/build and before review resumes at review. Assert agent invocation counts, candidate identity, and no duplicate `slice.completed` event.
11. Failed checkpoint persistence does not report a verified checkpoint or advance dependent work.
12. Two feature repairs exhaust that feature's budget. Repeated Resume does not replenish it. Final integration has its own bounded budget; unused earlier repairs do not enlarge it.
13. A follow-on preserves prior behavior and starts with a real increment. Recovery on a historical run still works with its existing approved plan.
14. Final full review still rejects an app missing any original requirement and deployment still requires valid review, health and metrics.
15. Full existing tests pass. Add a disposable HTTP journey proving default planned execution through reachable deployment, plus negative paths proving builds never start without approval.

Controller tests use the fixture provider; no subscription tokens are needed for this matrix. Add a small real CLI smoke only where adapter behavior changed and requires it; do not spend inference on tests already proven deterministically. Never read or mutate owner media/data.

Commands: start with `node --test test/wbs.test.mjs test/review.test.mjs`, then affected lifecycle/recovery tests; finish with `npm test` (including distro precheck) and `git diff --check`. Inspect failures; do not weaken assertions. No test run is claimed by this document-only planning task.

## 10. Scope boundaries and handoff

This PRD authorizes a future implementation proposal, not edits to the live photo run in this planning task. No runtime code, installed distribution, job state, frozen photo contract, or owner data was changed to produce this document.

Out of scope: automatic usage monitoring/provider switching, new model routing, parallel feature workers, a new scheduler, separate release jobs per feature, per-feature public/live deployment, new product features, and public release/push. Those requests must remain independent of this repair.

Definition of done for Claude's implementation: the ordinary new-run path cannot bypass decomposition/coverage approval; each feature is proved before advancing; interruption does not replay completed work or renew repair budgets; existing historical/recovery runs remain intact; tests and recipient documentation pass together. A new plan document or better prompt alone does not satisfy this PRD.

Do not restart or retrofit an active photo-library worker while implementing the factory change. Update any local installation only from the canonical source through generated distribution and normal installer at a safe idle boundary, under the owner's installation authorization. No public release or push is implied.


## 11. New empirical evidence: all recovery slices passed, final contract still failed

On 2026-10-09, run 2026-10-07-4f2dd1cf reached recoveryPhase=built with 15/15 scoped features verified, then failed final integration review after attempt16. The final audit identified seven concrete blocker groups. Source/evidence: /Users/loudalo/Documents/photo-library-prototype/projects/medialibrary/.factory/review-evidence/final-20261009/contract-audit.md and .factory/REVIEW.md. This is direct evidence that decomposition alone and existing scoped review do not establish full specification coverage.

The final reviewer assessed supplied SPEC/prototype handoff details beyond the shortened intake must-have text. Earlier plans and proof obligations did not fully express them. The planning fix must therefore reconcile ALL authoritative inputs before deriving obligations: frozen brief, PRD, ACCEPTANCE, attached supplied specification, and approved prototype handoff/visual checks. Snapshot and identify those input bytes; reference original section/check locations in the requirement registry. Original MH/SC IDs remain stable, but they are not an exhaustive replacement for detailed supplied requirements. Every detailed obligation must map to an owning feature and executable proof, and the plan reviewer must compare the obligations against those inputs for omissions. Final review must evaluate the same frozen source set, not introduce a different scope interpretation only at the end.

Add acceptance cases where broad MH/SC tags all appear but detailed supplied requirements are omitted: EXIF offsets/calendar-day semantics, all required EXIF filters/compound examples, semantic smart definitions/composed visual filters, independent manual/face association preservation, import batch/directory workflows, default durable inference assets, and V01–V14 paired populated UI states. Such plans must block before build. Where evidence is intentionally deferred to integration, mark that status explicitly; do not label the broad original requirement verified before its closing proof.

Do not waive the final audit or inflate budgets to solve this. Actual app defects still require focused implementation and executable regression proof. Keep normal new-run improvement separate from the preserved app recovery.
