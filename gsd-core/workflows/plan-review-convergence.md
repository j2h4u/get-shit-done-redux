<purpose>
Cross-AI plan convergence loop — automates the manual chain:
gsd-plan-phase N → gsd-review N --codex → gsd-plan-phase N --reviews → gsd-review N --codex → ...
Each step runs inside an isolated Agent that calls the corresponding Skill.
Orchestrator only does: init, loop control, parse CYCLE_SUMMARY for unresolved HIGH and actionable non-HIGH review findings, stall detection, escalation.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@$HOME/.claude/gsd-core/references/revision-loop.md
@$HOME/.claude/gsd-core/references/gates.md
@$HOME/.claude/gsd-core/references/agent-contracts.md
</required_reading>

<process>

## 1. Parse and Normalize Arguments

Extract from $ARGUMENTS: phase number, reviewer flags (`--codex`, `--gemini`, `--claude`, `--opencode`, `--ollama`, `--lm-studio`, `--llama-cpp`, `--all`), `--max-cycles N`, `--text`, `--ws`.

```bash
PHASE=$(echo "$ARGUMENTS" | grep -oE '[0-9]+\.?[0-9]*' | head -1)

REVIEWER_FLAGS=""
echo "$ARGUMENTS" | grep -q '\-\-codex' && REVIEWER_FLAGS="$REVIEWER_FLAGS --codex"
echo "$ARGUMENTS" | grep -q '\-\-gemini' && REVIEWER_FLAGS="$REVIEWER_FLAGS --gemini"
echo "$ARGUMENTS" | grep -q '\-\-claude' && REVIEWER_FLAGS="$REVIEWER_FLAGS --claude"
echo "$ARGUMENTS" | grep -q '\-\-opencode' && REVIEWER_FLAGS="$REVIEWER_FLAGS --opencode"
echo "$ARGUMENTS" | grep -q '\-\-ollama' && REVIEWER_FLAGS="$REVIEWER_FLAGS --ollama"
echo "$ARGUMENTS" | grep -q '\-\-lm-studio' && REVIEWER_FLAGS="$REVIEWER_FLAGS --lm-studio"
echo "$ARGUMENTS" | grep -q '\-\-llama-cpp' && REVIEWER_FLAGS="$REVIEWER_FLAGS --llama-cpp"
echo "$ARGUMENTS" | grep -q '\-\-all' && REVIEWER_FLAGS="$REVIEWER_FLAGS --all"
if [ -z "$REVIEWER_FLAGS" ]; then REVIEWER_FLAGS="--codex"; fi

MAX_CYCLES=$(echo "$ARGUMENTS" | grep -oE '\-\-max-cycles\s+[0-9]+' | awk '{print $2}')
if [ -z "$MAX_CYCLES" ]; then MAX_CYCLES=3; fi

GSD_WS=""
echo "$ARGUMENTS" | grep -qE '\-\-ws\s+\S+' && GSD_WS=$(echo "$ARGUMENTS" | grep -oE '\-\-ws\s+\S+')
```

## 1.5. Config Gate (feature disabled by default)

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="$HOME/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi
CONVERGENCE_ENABLED=$(gsd_run query config-get workflow.plan_review_convergence 2>/dev/null || echo "false")
```

**If `CONVERGENCE_ENABLED` is not `"true"`:** Display and exit:

```text
gsd-plan-review-convergence is disabled (workflow.plan_review_convergence=false).

This feature automates the plan→review→replan loop using external AI reviewers.
Enable it with:

  gsd config-set workflow.plan_review_convergence true

Then re-run: /gsd:plan-review-convergence {PHASE}
```

## 2. Initialize

```bash
INIT=$(node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" init plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `phase_dir`, `phase_number`, `padded_phase`, `phase_name`, `has_plans`, `plan_count`, `commit_docs`, `text_mode`, `response_language`.

**If `response_language` is set:** All user-facing output should be in `{response_language}`.

Set `TEXT_MODE=true` if `--text` is present in $ARGUMENTS OR `text_mode` from init JSON is `true`. When `TEXT_MODE` is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number.

## 3. Validate Phase + Pre-flight Gate

```bash
PHASE_INFO=$(node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" roadmap get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases. Exit.

Display startup banner:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► PLAN CONVERGENCE — Phase {phase_number}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Reviewers: {REVIEWER_FLAGS}
 Max cycles: {MAX_CYCLES}
```

## 4. Initial Planning (if no plans exist)

**If `has_plans` is true:** Skip to step 5. Display: `Plans found: {plan_count} PLAN.md files — skipping initial planning.`

**If `has_plans` is false:**

Display: `◆ No plans found — spawning initial planning agent... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

```text
Agent(
  description="Initial planning Phase {PHASE}",
  prompt="Run /gsd:plan-phase for Phase {PHASE}.

Execute: Skill(skill='gsd-plan-phase', args='{PHASE} {GSD_WS}')

Complete the full planning workflow. Do NOT return until planning is complete and PLAN.md files are committed.",
  mode="auto"
)
```

After agent returns, verify plans were created:
```bash
PLAN_COUNT=$(ls ${phase_dir}/${padded_phase}-*-PLAN.md 2>/dev/null | wc -l)
```

If PLAN_COUNT == 0: Error — initial planning failed. Exit.

Display: `Initial planning complete: ${PLAN_COUNT} PLAN.md files created.`

## 5. Convergence Loop

Initialize loop variables:

```text
cycle = 0
prev_unresolved_review_count = Infinity
```

### 5a. Review (Spawn Agent)

Increment `cycle`.

Display: `◆ Cycle {cycle}/{MAX_CYCLES} — spawning review agent... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

```text
Agent(
  description="Cross-AI review Phase {PHASE} cycle {cycle}",
  prompt="Run /gsd:review for Phase {PHASE}.

Execute: Skill(skill='gsd-review', args='--phase {PHASE} {REVIEWER_FLAGS} {GSD_WS}')

Complete the full review workflow. Do NOT return until REVIEWS.md is committed.

IMPORTANT — CYCLE_SUMMARY contract (required):
Your final response MUST include a machine-readable line of exactly this form:

  CYCLE_SUMMARY: current_high=<N> current_actionable=<M>

Where <N> is the integer count of HIGH-severity concerns that REMAIN UNRESOLVED in this cycle's findings.
Where <M> is the integer count of unresolved non-HIGH MEDIUM/LOW findings that require changes to the latest PLAN.md files before execution.

HIGH counting rules:
  INCLUDE in the count:
    - Newly raised HIGHs in this cycle
    - PARTIALLY RESOLVED HIGHs: concern acknowledged and a mitigation is in progress, but not yet verified/completed
    - Previously raised HIGHs that are still unresolved

  EXCLUDE from the count:
    - FULLY RESOLVED HIGHs: concern addressed with verification complete (closed ticket, verification log, or reviewer sign-off)
    - HIGH mentions in retrospective/summary tables comparing cycles
    - Quoted excerpts from prior reviews referencing past HIGH items

Definitions:
  PARTIALLY RESOLVED — concern acknowledged and mitigation is in progress but not yet verified/completed (e.g., open ticket exists but fix not landed).
  FULLY RESOLVED — concern addressed with verification complete (closed ticket, verification log, or explicit reviewer sign-off confirming closure).

Actionable non-HIGH counting rules:
  INCLUDE in current_actionable:
    - MEDIUM/LOW findings that require a concrete PLAN.md task, action, acceptance criterion, verification step, must_have, or threat/contract update before execution
    - Previously raised MEDIUM/LOW findings that still are not represented in the latest PLAN.md files
    - "Non-blocking" reviewer notes that still change what the executor must build or verify

  EXCLUDE from current_actionable:
    - INFO-only findings and source-grounding coverage notes
    - MEDIUM/LOW findings already incorporated into the latest PLAN.md files with a concrete executable contract
    - MEDIUM/LOW findings explicitly deferred or rejected in PLAN.md with a rationale the reviewer accepts
    - Retrospective/history mentions from prior cycles

Your final response MUST also include these sections immediately after the CYCLE_SUMMARY line:

## Current HIGH Concerns
[List each unresolved HIGH with a brief description, one per bullet]
[If none: write exactly 'None.']

## Current Actionable Non-HIGH Findings
[List each unresolved MEDIUM/LOW finding that still requires PLAN.md changes, one per bullet]
[If none: write exactly 'None.']",
  mode="auto"
)
```

### Source-grounding pass (config: `plan_review.source_grounding`, default on)

Run this pass unless `plan_review.source_grounding` is `false`. It verifies every symbol the plan cites against the project source before approval, catching hallucinated symbols at review time instead of execution time.

1. **Enumerate cited symbols.** List every referenced symbol by kind, quoting the plan line for each (coverage must be auditable): decorators (`@name`), classes/methods (`Class.method`), functions (`module.function`), CLI flags (`--name`), file paths, dataclass/struct fields.
2. **Exclude new artifacts.** Do NOT verify symbols the plan declares under its "Artifacts this phase produces" section — those are created by this phase, not references to existing code.
3. **Resolve each remaining symbol** using the adapter named by `plan_review.source_grounding_authority` (default `grep`):
   - `grep` — ripgrep / Read the source; confirm the name appears as a real declaration.
   - `intel` — consult `.planning/intel/API-SURFACE.md` / `api-map.json` (only when `intel.enabled`).
   Record one verdict per symbol: **VERIFIED** (quote `file:line`), **MISSING** (adapter can check this language/kind and the symbol is absent), **AMBIGUOUS** (multiple candidates), or **UNCHECKABLE** (adapter cannot analyze this language/kind — e.g. non-JS under `intel`, or any signature under `grep`). Never treat UNCHECKABLE as verified or missing.
4. **Severity & gating:**
   - **MISSING** at authority `grep`/`intel` → `needs-acknowledgement`: the plan proceeds only if the author confirms the symbol is genuinely new or dynamically resolved, and that acknowledgement is recorded. A hard block is reserved for higher-authority adapters (LSP/SCIP) that can prove absence.
   - **AMBIGUOUS** → MEDIUM. **UNCHECKABLE** → INFO.
   - Signature mismatches cannot be asserted under `grep`/`intel`; report the signature as UNCHECKABLE.
5. **Coverage block.** Append a "Verification coverage" section to `REVIEWS.md` listing every UNCHECKABLE/skipped symbol and why — a clean review must never silently mean "nothing was checked."

After agent returns, verify REVIEWS.md exists:
```bash
REVIEWS_FILE=$(ls ${phase_dir}/${padded_phase}-REVIEWS.md 2>/dev/null)
```

If REVIEWS_FILE is empty: Error — review agent did not produce REVIEWS.md. Exit.

### 5b. Extract Unresolved Review Counts from CYCLE_SUMMARY Contract

**Do NOT grep REVIEWS.md for HIGH/MEDIUM/LOW counts.** REVIEWS.md accumulates history across cycles — resolved findings from prior cycles remain in the file as audit trail, inflating a raw grep count and causing false stall detection.

Parse HIGH_COUNT and ACTIONABLE_COUNT from the review agent's return message via the CYCLE_SUMMARY contract:

```bash
# Extract integers from "CYCLE_SUMMARY: current_high=N current_actionable=M" in the agent's return message.
SUMMARY_LINE=$(echo "$REVIEW_AGENT_RETURN" | grep -oE 'CYCLE_SUMMARY:\s*current_high=[0-9]+[[:space:]]+current_actionable=[0-9]+' | head -1)
HIGH_COUNT=$(echo "$SUMMARY_LINE" | grep -oE 'current_high=[0-9]+' | grep -oE '[0-9]+$')
ACTIONABLE_COUNT=$(echo "$SUMMARY_LINE" | grep -oE 'current_actionable=[0-9]+' | grep -oE '[0-9]+$')

if [ -z "$HIGH_COUNT" ] || [ -z "$ACTIONABLE_COUNT" ]; then
  # Distinguish malformed contract from completely absent contract
  if echo "$REVIEW_AGENT_RETURN" | grep -q 'CYCLE_SUMMARY:'; then
    echo "CYCLE_SUMMARY present but current_high/current_actionable is malformed — expected: CYCLE_SUMMARY: current_high=<N> current_actionable=<M>. Retry or switch reviewer."
  else
    echo "Review agent did not honor the CYCLE_SUMMARY contract — cannot determine unresolved review counts. Retry or switch reviewer."
  fi
  exit 1
fi

UNRESOLVED_REVIEW_COUNT=$((HIGH_COUNT + ACTIONABLE_COUNT))

# Extract the ## Current HIGH Concerns section from the agent's return message
HIGH_LINES=$(echo "$REVIEW_AGENT_RETURN" | awk '/^## Current HIGH Concerns/{found=1; next} found && /^##/{exit} found{print}')
ACTIONABLE_LINES=$(echo "$REVIEW_AGENT_RETURN" | awk '/^## Current Actionable Non-HIGH Findings/{found=1; next} found && /^##/{exit} found{print}')

if [ "${HIGH_COUNT}" -gt 0 ] && [ -z "${HIGH_LINES}" ]; then
  echo "⚠ Review agent's CYCLE_SUMMARY reports ${HIGH_COUNT} HIGHs but did not provide ## Current HIGH Concerns section — continuing with incomplete escalation details."
fi

if [ "${ACTIONABLE_COUNT}" -gt 0 ] && [ -z "${ACTIONABLE_LINES}" ]; then
  echo "⚠ Review agent's CYCLE_SUMMARY reports ${ACTIONABLE_COUNT} actionable non-HIGH findings but did not provide ## Current Actionable Non-HIGH Findings section — continuing with incomplete escalation details."
fi
```

**If HIGH_COUNT == 0 AND ACTIONABLE_COUNT == 0 (converged):**

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state planned-phase --phase "${PHASE}" --name "${phase_name}" --plans "${PLAN_COUNT}"
```

Display:
```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► CONVERGENCE COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Phase {phase_number} converged in {cycle} cycle(s).
 No HIGH concerns or actionable non-HIGH plan changes remaining.

 REVIEWS.md: {REVIEWS_FILE}
 Next: /gsd:execute-phase {PHASE}
```

Exit — convergence achieved.

**If HIGH_COUNT > 0 OR ACTIONABLE_COUNT > 0:** Continue to 5c. Actionable non-HIGH findings trigger replanning because execute-phase reads PLAN.md as the execution contract; review-only instructions must not remain stranded in REVIEWS.md.

### 5c. Stall Detection + Escalation Check

Display: `◆ Cycle {cycle}/{MAX_CYCLES} — {HIGH_COUNT} HIGH concerns and {ACTIONABLE_COUNT} actionable non-HIGH findings found`

**Stall detection:** If `UNRESOLVED_REVIEW_COUNT >= prev_unresolved_review_count`:
```text
⚠ Convergence stalled — unresolved review finding count not decreasing
  ({HIGH_COUNT} HIGH + {ACTIONABLE_COUNT} actionable non-HIGH findings; previous cycle had {prev_unresolved_review_count} total)
```

**Max cycles check:** If `cycle >= MAX_CYCLES`:

If `TEXT_MODE` is true, present as plain-text numbered list:
```text
Plan convergence did not complete after {MAX_CYCLES} cycles.
{HIGH_COUNT} HIGH concerns and {ACTIONABLE_COUNT} actionable non-HIGH findings remain:

{HIGH_LINES}

{ACTIONABLE_LINES}

How would you like to proceed?

1. Proceed anyway — Accept plans with remaining review findings and move to execution
2. Manual review — Stop here, review REVIEWS.md and address concerns manually

Enter number:
```

Otherwise use AskUserQuestion:
```js
AskUserQuestion([
  {
    question: "Plan convergence did not complete after {MAX_CYCLES} cycles. {HIGH_COUNT} HIGH concerns and {ACTIONABLE_COUNT} actionable non-HIGH findings remain:\n\n{HIGH_LINES}\n\n{ACTIONABLE_LINES}\n\nHow would you like to proceed?",
    header: "Convergence",
    multiSelect: false,
    options: [
      { label: "Proceed anyway", description: "Accept plans with remaining review findings and move to execution" },
      { label: "Manual review", description: "Stop here — review REVIEWS.md and address concerns manually" }
    ]
  }
])
```

If "Proceed anyway": Display final status and exit.
If "Manual review":
```text
Review the concerns in: {REVIEWS_FILE}

To replan manually:  /gsd:plan-phase {PHASE} --reviews
To restart loop:     /gsd:plan-review-convergence {PHASE} {REVIEWER_FLAGS}
```
Exit workflow.

### 5d. Replan (Spawn Agent)

**If under max cycles:**

Update `prev_unresolved_review_count = UNRESOLVED_REVIEW_COUNT`.

Display: `◆ Spawning replan agent with review feedback... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

```text
Agent(
  description="Replan Phase {PHASE} with review feedback cycle {cycle}",
  prompt="Run /gsd:plan-phase with --reviews for Phase {PHASE}.

Execute: Skill(skill='gsd-plan-phase', args='{PHASE} --reviews --skip-research {GSD_WS}')

This will replan incorporating cross-AI review feedback from REVIEWS.md.
It MUST incorporate every current actionable review finding into executable PLAN.md content or explicitly document an accepted deferral/rejection in PLAN.md.
Do NOT return until replanning is complete and updated PLAN.md files are committed.

IMPORTANT: When gsd-plan-phase outputs '## PLANNING COMPLETE', that means replanning is done. Return at that point.",
  mode="auto"
)
```

After agent returns → go back to **step 5a** (review again).

</process>

<success_criteria>
- [ ] Config gate checked before running — exits with enable instructions if workflow.plan_review_convergence is false
- [ ] Initial planning via Agent → Skill("gsd-plan-phase") if no plans exist
- [ ] Review via Agent → Skill("gsd-review") — isolated, not inline; {GSD_WS} forwarded
- [ ] Replan via Agent → Skill("gsd-plan-phase --reviews") — isolated, not inline
- [ ] Orchestrator only does: init, config gate, loop control, parse CYCLE_SUMMARY for unresolved HIGH/actionable non-HIGH counts, stall detection, escalation
- [ ] HIGH and actionable non-HIGH counts extracted from review agent's CYCLE_SUMMARY return message (not by grepping REVIEWS.md)
- [ ] Review agent prompt defines CYCLE_SUMMARY: current_high=<N> current_actionable=<M> contract with PARTIALLY/FULLY RESOLVED definitions
- [ ] Convergence requires both HIGH_COUNT == 0 and ACTIONABLE_COUNT == 0 so review findings cannot remain only in REVIEWS.md
- [ ] Abort with clear error if CYCLE_SUMMARY is absent; distinguish malformed from absent
- [ ] Warn if HIGH_COUNT > 0 but ## Current HIGH Concerns section is absent from return message
- [ ] Warn if ACTIONABLE_COUNT > 0 but ## Current Actionable Non-HIGH Findings section is absent from return message
- [ ] Each Agent fully completes its Skill before returning
- [ ] Loop exits on: no HIGH concerns and no actionable non-HIGH findings (converged) OR max cycles (escalation)
- [ ] Stall detection reported when unresolved review finding count is not decreasing
- [ ] STATE.md updated on convergence completion
</success_criteria>
