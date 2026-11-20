# Authored benchmark scenarios (local only)

Put the `FEATURE-<n>.json` files written by `factory scenarios` here, or keep them anywhere else and pass
`node bench/factory/run.mjs --scenarios-dir <dir>`.

Everything in this directory except this README is gitignored on purpose: the held-out scenarios must never be committed to the
repository whose prompts are tuned against the benchmark. Do not force-add them.
