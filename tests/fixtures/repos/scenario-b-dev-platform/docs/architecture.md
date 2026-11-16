# Architecture
gateway -> Redis stream `events` -> worker -> destinations. Postgres stores endpoints, API keys, delivery attempts.
Multi-tenancy is by `org_id` column; row-level security is planned. Replay is implemented in the dashboard only (no public API yet).
