---
type: feature-spec
id: FEATURE-001
opportunity: OPP-001
status: ready
product_revision: 1
created: 2026-11-16
---
# Signed outbound webhooks

## 1. Feature overview

Every outbound delivery carries an HMAC signature header, computed with a per-endpoint secret, so receivers can verify authenticity and reject replays.

## 2. Problem statement

Receivers cannot verify that a webhook came from Relay [E: fact; high; repo:services/worker/src/deliver.ts:3; 2026-11-16].

## 3. Business justification

Table stakes for security-conscious integrators; a direct competitor documents signed deliveries [E: fact; high; https://example.com/hookforge/docs/signatures; 2026-11-16]. Originates from OPP-001.

## 4. Target users and personas

- **Integration developer (receiver side)** — consumes Relay webhooks; needs to verify origin.
- **Endpoint owner (sender side)** — configures destinations in the dashboard; needs to manage secrets.

## 5. User stories

- As an integration developer, I want each delivery signed so that I can reject forged requests.
- As an endpoint owner, I want to rotate an endpoint secret without dropping deliveries.

## 6. Functional requirements

| ID | Requirement | Type |
|---|---|---|
| FR-1 | The worker shall add a signature header and a timestamp header to every outbound delivery. | [Approved] |
| FR-2 | The signature shall be an HMAC of timestamp plus raw body using the endpoint secret. | [Suggestion] |
| FR-3 | Endpoint owners shall be able to view, create and rotate an endpoint secret in the dashboard. | [Approved] |
| FR-4 | During rotation both old and new secrets shall be valid for signing verification guidance for a configurable window. | [Suggestion] |

## 7. Non-functional requirements

| ID | Requirement | Measure |
|---|---|---|
| NFR-1 | Signing adds negligible latency | p95 added latency under 5 ms per delivery |
| NFR-2 | Secrets are never logged | Zero secret values in logs and delivery records |

## 8. User journeys and expected UX

Owner opens endpoint settings, reveals the secret once at creation, copies it, and later rotates it. Receiver reads the documented headers and verifies the signature.

## 9. Technical considerations

**Constraints from the existing system:** signing belongs in the single delivery path [E: fact; high; repo:services/worker/src/deliver.ts:2; 2026-11-16]; endpoints live in Postgres [E: fact; high; repo:docs/architecture.md:1; 2026-11-16].

**Suggested approach [Suggestion — implementer may choose otherwise]:** HMAC-SHA256 with a versioned header so the scheme can change later.

## 10. Acceptance criteria

| ID | Covers | Criterion |
|---|---|---|
| AC-1 | FR-1 | **Given** an endpoint with a secret **When** an event is delivered **Then** the request has signature and timestamp headers |
| AC-2 | FR-2 | **Given** the documented algorithm **When** a receiver recomputes the signature **Then** it equals the header value |
| AC-3 | FR-3 | **Given** an endpoint owner **When** they rotate the secret **Then** subsequent deliveries are signed with the new secret and the old one is shown as retired |
| AC-4 | NFR-2 | **Given** deliveries are logged **When** logs are searched for the secret **Then** no matches exist |

## 11. Edge cases

- Endpoint without a secret (existing endpoints): signing is skipped until a secret exists, and the dashboard prompts the owner.
- Retries re-sign with a fresh timestamp.

## 12. Error and failure scenarios

- Secret missing at delivery time → delivery proceeds unsigned only if the endpoint has never had a secret; otherwise the delivery fails and is retried.

## 13. Security and privacy considerations

Secrets stored encrypted at rest; shown in full only at creation; never logged. Replay protection relies on the timestamp tolerance documented for receivers.

## 14. Out of scope

- Mutual TLS, per-event signatures, receiver SDKs, SOC 2 evidence work.

## 15. Dependencies

- Endpoint settings UI in the dashboard; a key-management approach for secrets at rest.

## 16. Success metrics

| Metric | Baseline | Target | Measurement |
|---|---|---|---|
| Share of active endpoints with a secret | 0 | set by the owner | Postgres query |

## 17. Research references

- Originating opportunity: OPP-001
- Competitor signing documentation [E: fact; high; https://example.com/hookforge/docs/signatures; 2026-11-16]

## 18. Unresolved decisions

- Where encryption keys for secrets at rest come from (the implementer should ask the user; the spec assumes an existing key source).

## 19. Implementation handoff

- **Product baseline:** PRODUCT.md revision 1
- **Read first:** services/worker/src/deliver.ts, docs/architecture.md, services/dashboard endpoint settings
- **Definition of done:** all acceptance criteria pass; no out-of-scope work; no new unresolved decisions invented.
- **Questions go to:** the user, via the implementation agent. Do not guess requirements.
- **Suggested verification:** AC-1..AC-4 as integration tests.
