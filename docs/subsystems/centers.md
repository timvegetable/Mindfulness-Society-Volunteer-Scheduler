# Center workflow subsystem

## Ownership

`models.ts` defines centers, candidate intervals, caller scope, coverage, and confirmation results. `stores.ts` defines repository contracts and memory implementations. `codecs.ts` maps center rows. `service.ts` owns tenant access, candidate CRUD, advisory coverage, and administrator confirmation.

## Tenant and state boundaries

Center contacts can list, create, and edit only candidates belonging to their authorized `centerIds`. Administrators can see all centers. Administrators bypass center scoping by design; a multi-role account renders the administrator surface, so center-contact browser verification needs a center-contact-only Users row.

Candidate intervals are Monday–Friday proposals, not committed sessions and not promises. Resolved/confirmed candidates are immutable through the candidate edit path. The API and service both enforce that center contacts cannot confirm a candidate.

## Coverage and confirmation

Advisory coverage ranks active eligible volunteers whose recurring interval fully contains the candidate interval. Date-specific confirmation re-evaluates current exceptions and overlapping assignments. Coverage labels are explicitly non-promissory.

Only an administrator may confirm. Confirmation re-reads current candidate state and coverage, enforces the two-volunteer maximum, rejects shortfall or overlap with an existing locked occurrence, prevents duplicate confirmation, creates auditable locked session occurrences linked by `sourceCandidateId`, and updates candidate state under expected revision.

The client receives a center name on each candidate because an administrator can view multiple centers at once. Do not rely on a single shared heading for row attribution.

