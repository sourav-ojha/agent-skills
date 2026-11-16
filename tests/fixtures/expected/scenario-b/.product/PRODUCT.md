---
type: product-context
status: approved
revision: 1
last_reviewed: 2026-11-16
approved_by: Fixture Owner
approved_at: 2026-11-16
content_hash: "sha256:82240147ba81b20040a571191173f0175d535d121029f6a87de01e32fae9c554"
---
# Relay — Product Context

## 1. Product overview

Relay is a multi-tenant event-routing and background-job platform: it ingests webhooks, fans events out to customer destinations with retries and dead-letter queues, and runs scheduled jobs [E: fact; high; repo:README.md:3; 2026-11-16]. It consists of three services (Go gateway, TypeScript worker, React dashboard) plus Redis and Postgres [E: fact; high; repo:infra/docker-compose.yml:2; 2026-11-16].

## 2. Problem statement

Engineering teams need reliable delivery of events to third-party endpoints without building retry, backoff and observability themselves [E: inference; medium; repo:README.md:3; 2026-11-16].

## 3. Target audience

| Segment | Who they are | Evidence |
|---|---|---|
| Engineering teams (SaaS) | Teams that send webhooks to customers or integrate with partners | [E: inference; medium; repo:README.md:3; 2026-11-16] |
| Enterprises (self-hosted) | Organizations needing the platform in their own environment | [E: fact; medium; repo:README.md:3; 2026-11-16] |

## 4. Value proposition

Reliable, observable event delivery with replay, offered as hosted SaaS or self-hosted [E: fact; medium; repo:README.md:3; 2026-11-16]. Reliability claims are not benchmarked in the repository [E: unknown; low; search:no load tests or SLOs found].

## 5. Core user journeys

### Journey 1: Send an event to a destination
1. Sender calls the gateway with an API key [E: fact; high; repo:services/gateway/src/main.go:4; 2026-11-16]
2. Gateway validates and enqueues to the Redis stream `events` [E: fact; high; repo:docs/architecture.md:2; 2026-11-16]
3. Worker delivers with exponential backoff (max 8 attempts) then dead-letters [E: fact; high; repo:services/worker/src/deliver.ts:2; 2026-11-16]

### Journey 2: Diagnose and replay a failed delivery
1. Operator opens delivery logs in the dashboard [E: fact; high; repo:services/dashboard/src/Logs.tsx:1; 2026-11-16]
2. Uses the replay button; there is no public replay API [E: fact; high; repo:docs/architecture.md:3; 2026-11-16]

## 6. Existing capabilities

| Capability | Status (complete / partial / stub) | Evidence |
|---|---|---|
| API-key auth and global rate limit at gateway | partial (global limit only) | [E: fact; high; repo:services/gateway/src/main.go:3; 2026-11-16] |
| Delivery with backoff and dead-letter queue | complete | [E: fact; high; repo:services/worker/src/deliver.ts:2; 2026-11-16] |
| Outbound request signing | not implemented | [E: fact; high; repo:services/worker/src/deliver.ts:3; 2026-11-16] |
| Delivery log and replay (dashboard only) | partial | [E: fact; high; repo:services/dashboard/src/Logs.tsx:1; 2026-11-16] |
| Multi-tenancy by org_id column | partial (row-level security planned) | [E: fact; high; repo:docs/architecture.md:3; 2026-11-16] |

## 7. Business model

Tiered pricing is stated in the README: Free (10k events/month), Team ($49), Enterprise (contact us) [E: fact; medium; repo:README.md:10; 2026-11-16]. No billing code exists in the repository, so enforcement of limits is unverified [E: unknown; medium; search:searched repo for billing and quota code].

## 8. Technical overview

- **Stack:** Go (gateway), TypeScript (worker, dashboard), React, Redis streams, Postgres [E: fact; high; repo:infra/docker-compose.yml:2; 2026-11-16]
- **Architecture:** gateway → Redis stream → worker → destinations; Postgres holds endpoints, keys, delivery attempts [E: fact; high; repo:docs/architecture.md:2; 2026-11-16]
- **Integrations:** customer webhook destinations; no third-party SDKs visible
- **Deployment / operations:** docker-compose for local; production deployment not visible

## 9. Known limitations

- Rate limits are global rather than per organization [E: fact; high; repo:services/gateway/src/main.go:3; 2026-11-16]
- Outbound webhooks carry no signature header [E: fact; high; repo:services/worker/src/deliver.ts:3; 2026-11-16]
- Delivery logs have no CSV export and no payload search [E: fact; high; repo:services/dashboard/src/Logs.tsx:1; 2026-11-16]
- Row-level security for tenant isolation is only planned [E: fact; high; repo:docs/architecture.md:3; 2026-11-16]

## 10. Assumptions and unanswered questions

### Assumptions
- The hosted SaaS is the primary revenue source [E: assumption; low; n/a]

### Unanswered questions for the user
- Which tier drives revenue today, and what are the top churn reasons?
- Is SOC 2 work in progress or completed? (see conflict below)

### Conflicting evidence
- README claims "SOC 2 Type II compliant" [E: fact; high; repo:README.md:12; 2026-11-16] but tenant isolation is only planned, with no audit artifacts in the repository [E: fact; high; repo:docs/architecture.md:3; 2026-11-16]. Treated as an unverified marketing claim, not a capability, pending the user's answer.

## 11. Evidence and confidence

| Area | Confidence | Basis |
|---|---|---|
| Purpose and audience | Medium | [E: fact; medium; repo:README.md:3; 2026-11-16] |
| Capabilities | High | [E: fact; high; repo:services/worker/src/deliver.ts:2; 2026-11-16] |
| Business model | Low | [E: unknown; medium; search:no billing code] |
| Technical overview | High | [E: fact; high; repo:infra/docker-compose.yml:2; 2026-11-16] |

Repository inspected at: abc1234 on 2026-11-16. Agents used: repository-analyst x3 (architecture, product+journeys, quality-gaps) at the fast tier; business model inferred by the orchestrator.

## Revision History

| Revision | Date | By | Action | Note |
|---|---|---|---|---|
| 1 | 2026-11-16 | Fixture Owner | approved | synthetic fixture |
