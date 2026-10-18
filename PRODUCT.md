# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three co-primary groups use the scheduler:

- **Volunteers** review weekly availability imported from WhenIsGood and manage dated exceptions, view upcoming sessions and assignments, and cancel assignments when needed.
- **Administrators** preview and publish schedules, review assignments, backups, and shortfalls, monitor availability synchronization, resolve participant identities, read staffing insights, and confirm center proposals.
- **Center contacts** propose weekday session slots for their center, edit or withdraw unconfirmed proposals, and review advisory volunteer coverage.

## Product Purpose

Coordinate volunteer staffing for mindfulness sessions across three centers by automating assignments from volunteer availability. Success means sessions are reliably staffed with less manual coordination.

## Positioning

Automated scheduling based on volunteer availability.

## Operating Context

The mindfulness society runs sessions at three centers. Volunteers submit weekly availability through WhenIsGood and review the imported times in the scheduler. They can add date-specific exceptions in the scheduler. Administrators review a schedule preview before publishing or rerunning it, and monitor automatically synchronized WhenIsGood availability. Center contacts propose weekday and time slots. Proposal coverage is advisory; confirming a proposal checks the actual upcoming date and creates one dated session rather than a permanent recurrence.

The configured defaults are America/New_York for time zone, 30 minutes for display increments, and 09:00–21:00 for operating hours.

## Capabilities and Constraints

- Users sign in with society-approved Google accounts. The application resolves volunteer, administrator, and center-contact roles from its database; there is no anonymous or development authentication bypass.
- Schedule preview does not write data. Publishing creates a versioned schedule output. Center proposal coverage does not reserve volunteers.
- A scheduled Cloudflare Worker checks WhenIsGood every 30 minutes. Matched volunteers update automatically; new and ambiguous participants remain in an administrator-only queue until linked. Enrollment and account approval remain separate. Browser views read saved data on load, navigation, or Reload view; there is no periodic browser polling.
- Mutations require the current data revision and an idempotency key. A stale revision requires the user to reload, review current information, and submit again. Unchanged synchronization checks preserve domain and scheduling revisions; their timestamps update independently.
- Relevant successful changes trigger administrative email notifications after commit; a notification failure does not undo the saved change. Gmail sending is authorized separately, and volunteers do not grant Gmail access.
- The client and API share one origin. D1 is the system of record. Private roster data and credentials must stay out of source control; automated tests use synthetic data.
- The organization is the UMD Mindfulness Society. Use the official supplied `public/umd-mindfulness-icon.svg` lotus and seated-figure icon, preserved from `mindfulness_society_icon.svg`. Its amber (#f4b64f) and fresh green (#81d254) establish the identity; deep forest green supports accessible text and controls over neutral warm off-white and white surfaces. Follow the supplied schedule-page reference: cream circular logo badge, green actions and publication state, neutral session-status pills, muted red cancelled status, gold shortfall badges, and a schedule table that grows vertically. Keep workspace copy direct and concise.

## Evidence on Hand

The repository includes a synthetic fixture with three centers and five fictional volunteers. The operator's roster is handled as private seed data and is not tracked in Git. No real testimonials, usage metrics, case studies, or approved marketing assets are documented; future work must not fabricate them.

## Product Principles

- Base automated schedules on volunteer availability.
- Optimize for reliable staffing with less manual coordination.
- Let administrators review a schedule before publishing it.
- Keep proposed sessions tentative until coverage is checked against the actual date.
- Protect volunteer data through role-scoped access and private roster handling.
