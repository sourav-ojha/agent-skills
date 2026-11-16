---
type: opportunity-registry
last_research: 2026-11-16
review_mode: self-review
review_note: Host had no second agent available in this run; a separate self-review pass used the reviewer checklist.
decision_count: 3
decision_head: 85a4593fa89b
---
# Opportunities

> Synthetic fixture: competitors are fictional; sources use example.com.

## Market Landscape

Last researched: 2026-11-16. Scope: webhook delivery platforms, managed queues, open-source webhook gateways.

### Direct competitors

| Name | Positioning | Audience | Pricing | Key strengths | Key weaknesses | Evidence |
|---|---|---|---|---|---|---|
| HookForge | Managed webhook sending for SaaS teams | SaaS engineering teams | Free tier; usage-based paid | Signed deliveries, customer portal | No self-hosted option | [E: fact; high; https://example.com/hookforge/docs/signatures; 2026-11-16] |
| PushQueue | Managed event bus with retries | Platform teams | Tiered, from $25/mo | Per-tenant rate limits | Weak replay tooling | [E: fact; medium; https://example.com/pushqueue/pricing; 2026-11-16] |

### Indirect competitors

| Name | Positioning | Audience | Pricing | Key strengths | Key weaknesses | Evidence |
|---|---|---|---|---|---|---|
| Cloud queue + cron DIY | Build delivery on a managed queue service | Larger teams with platform capacity | Pay per use | Full control | Teams reimplement retries, signing, logs | [E: inference; medium; https://example.com/blog/diy-webhooks; 2026-11-16] |

### Open-source alternatives

| Project | License | Last release / commit | Maintained? | Usable commercially? | Relevance | Evidence |
|---|---|---|---|---|---|---|
| hookgate | Apache-2.0 | 2026-09-12 / 2026-11-02 | Yes | Yes (Apache-2.0) | Competes for self-hosted users; lacks dashboard | [E: fact; high; https://example.com/hookgate; 2026-11-16] |

### Emerging products

None found — searched: "webhook infrastructure launch 2026", launch directories; only re-skins of existing tools [E: fact; low; search:search log 2026-11-16]

### Adjacent products and markets

| Name | Positioning | Audience | Pricing | Key strengths | Key weaknesses | Evidence |
|---|---|---|---|---|---|---|
| Observability suites | Add webhook delivery tracing | Platform teams | Varies | Existing buyer relationship | Not delivery-focused | [E: inference; low; https://example.com/observability-webhooks; 2026-11-16] |

### Changes since previous research

First research run.

## Registry

| ID | Title | Status | Score | Confidence | Tier | Effort | Updated | Feature |
|---|---|---|---|---|---|---|---|---|
| OPP-001 | Signed outbound webhooks | Ready for Implementation | 83 | High | Recommend | S | 2026-11-16 | FEATURE-001 |
| OPP-002 | Per-organization rate limits | Proposed | 69 | Medium | Consider | M | 2026-11-16 | - |
| OPP-003 | Delivery log CSV export | Rejected | 50 | Low | Backlog | S | 2026-11-16 | - |
| OPP-004 | Payload search in delivery logs | Deferred | 63 | Low | Needs evidence | L | 2026-11-16 | - |

## Review Summary

Self-review (no second agent available). Challenged: OPP-001 evidence upgraded to High after confirming the missing header in worker code and a competitor's signing docs; OPP-002 differentiation capped at 2 (parity with PushQueue); OPP-004 evidence is a single review, so confidence Low. The SOC 2 claim was not used as evidence for any opportunity. Not verified: real customer demand for CSV export.

## Decision Log

| Date | ID | Decision | By | Note | Seal |
|---|---|---|---|---|---|
| 2026-11-16 | OPP-001 | approve | Fixture Owner | user: approved | 3d7e79a2bd78 |
| 2026-11-16 | OPP-003 | reject | Fixture Owner | user: no demand, skip | 7516cb178b0d |
| 2026-11-16 | OPP-004 | defer | Fixture Owner | user: revisit after retention policy | 85a4593fa89b |

## Opportunity Details

### OPP-001 — Signed outbound webhooks

- **Category:** feature parity
- **Source direction:** internal gap + competitor weakness
- **Problem:** Receivers cannot verify that a webhook came from Relay [E: fact; high; repo:services/worker/src/deliver.ts:3; 2026-11-16]
- **Proposed solution:** Add an HMAC signature header per endpoint secret, with timestamp and rotation support
- **Why it matters:** Table stakes for security-conscious integrators; supports the Enterprise tier
- **Evidence:** Competitor documents signed deliveries [E: fact; high; https://example.com/hookforge/docs/signatures; 2026-11-16]; gap confirmed in code [E: fact; high; repo:services/worker/src/deliver.ts:3; 2026-11-16]
- **Competitive context:** HookForge signs deliveries; Relay does not [E: fact; high; https://example.com/hookforge/docs/signatures; 2026-11-16]
- **Expected value:** Fewer security objections in enterprise evaluations; unblocks regulated users
- **Effort:** S — single worker code path plus a secret field on endpoints
- **Risks:** Secret storage and rotation UX
- **Dependencies:** Endpoint settings UI in the dashboard
- **Ratings:** user_value=4, strategic_alignment=5, market_opportunity=4, competitive_differentiation=3, business_impact=4, implementation_feasibility=5

### OPP-002 — Per-organization rate limits

- **Category:** performance and reliability
- **Source direction:** internal gap
- **Problem:** One tenant can exhaust the shared limit [E: fact; high; repo:services/gateway/src/main.go:3; 2026-11-16]
- **Proposed solution:** Enforce limits keyed by org_id with plan-based defaults
- **Why it matters:** Noisy-neighbour protection is required for tiered pricing to mean anything
- **Evidence:** Limit is global today [E: fact; high; repo:services/gateway/src/main.go:3; 2026-11-16]; PushQueue advertises per-tenant limits [E: fact; medium; https://example.com/pushqueue/pricing; 2026-11-16]
- **Competitive context:** Parity with PushQueue
- **Expected value:** Protects reliability and makes plan limits enforceable
- **Effort:** M — gateway change plus plan lookup
- **Risks:** Requires deciding plan-to-limit mapping (business decision)
- **Dependencies:** Billing or plan source of truth (absent in repo)
- **Ratings:** user_value=4, strategic_alignment=4, market_opportunity=3, competitive_differentiation=2, business_impact=4, implementation_feasibility=3

### OPP-003 — Delivery log CSV export

- **Category:** feature parity
- **Problem:** Operators may want logs in spreadsheets [E: hypothesis; low; n/a]
- **Proposed solution:** CSV export from the logs table
- **Why it matters:** Convenience
- **Evidence:** No user evidence found [E: unknown; low; search:searched issues and reviews]
- **Competitive context:** Common feature; not a differentiator
- **Expected value:** Minor
- **Effort:** S
- **Risks:** Data-exposure risk if exports are unscoped
- **Dependencies:** None
- **Ratings:** user_value=3, strategic_alignment=3, market_opportunity=2, competitive_differentiation=1, business_impact=2, implementation_feasibility=4

### OPP-004 — Payload search in delivery logs

- **Category:** differentiation
- **Problem:** Debugging requires finding deliveries by payload content [E: fact; low; https://example.com/reviews/relay-like-1; 2026-11-16]
- **Proposed solution:** Indexed payload search with retention controls
- **Why it matters:** Debugging speed is core to the value proposition
- **Evidence:** One review mentions it [E: fact; low; https://example.com/reviews/relay-like-1; 2026-11-16]
- **Competitive context:** PushQueue has weak search [E: inference; low; ref:PushQueue weakness; 2026-11-16]
- **Expected value:** Potentially strong for debugging-heavy users
- **Effort:** L — indexing, storage and privacy controls
- **Risks:** Sensitive payload retention
- **Dependencies:** Data retention policy
- **Ratings:** user_value=4, strategic_alignment=3, market_opportunity=3, competitive_differentiation=3, business_impact=3, implementation_feasibility=2
