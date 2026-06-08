---
type: Fixed
pr: 854
---

Roadmap milestone scoping now resolves active `<details open>` milestones whose checklist references phases while the executable `### Phase N:` sections live in a shared flat `## Phase Details` section. `init.plan-phase`, `init.progress`, and other roadmap-backed commands now append only the referenced phase detail sections, so active phases can be planned before their `.planning/phases/` directories exist without leaking shipped or backlog phases. (#723)
