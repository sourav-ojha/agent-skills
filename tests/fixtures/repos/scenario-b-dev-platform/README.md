# Relay

Event routing and background-job platform for engineering teams. Ingest webhooks, fan them out to destinations with retries,
and run scheduled/background jobs. Multi-tenant SaaS with a self-hosted enterprise edition.

- **Gateway** (Go): authenticates API keys, rate-limits, validates payloads, enqueues events.
- **Worker** (TypeScript): delivers events with exponential backoff and dead-letter queues.
- **Dashboard** (React): delivery logs, replay, endpoint management, team settings.

Security: SOC 2 Type II compliant. Pricing: Free (10k events/mo), Team ($49), Enterprise (contact us).
