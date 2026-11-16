---
type: feature-spec
id: FEATURE-001
opportunity: OPP-001
status: ready
product_revision: 1
created: 2026-11-16
---
# Batch image processing

## 1. Feature overview

Let users select several images, apply one set of resize/quality/format settings, and download all results as a single ZIP, entirely in the browser.

## 2. Problem statement

Users with several photos must repeat the whole flow per image [E: fact; high; repo:src/resize.js:1; 2026-11-16].

## 3. Business justification

Serves repeat usage and the privacy-first positioning; a competitor already batches but uploads files [E: fact; high; https://example.com/shrinkray/pricing; 2026-11-16]. See OPP-001.

## 4. Target users and personas

- **Casual photo sharer** — has 5–30 photos to send by email; wants one step; frustrated by repetition.

## 5. User stories

- As a casual photo sharer, I want to drop several images at once so that I resize them in one step.

## 6. Functional requirements

| ID | Requirement | Type |
|---|---|---|
| FR-1 | The system shall accept multiple files via drag-and-drop and file picker. | [Approved] |
| FR-2 | The system shall apply the current width, quality and format settings to every file. | [Approved] |
| FR-3 | The system shall offer all outputs as one ZIP download. | [Approved] |
| FR-4 | The system shall process files locally and send nothing over the network. | [Approved] |

## 7. Non-functional requirements

| ID | Requirement | Measure |
|---|---|---|
| NFR-1 | Responsiveness during processing | UI stays interactive; progress shown per file |
| NFR-2 | Memory safety | 50 files of 5 MB each complete without a page crash on a mid-range laptop |

## 8. User journeys and expected UX

Drop several images, see a list with per-file progress, adjust shared settings, click "Download ZIP". Single-file flow is unchanged.

## 9. Technical considerations

**Constraints from the existing system:** resizing is a single-file Canvas function [E: fact; high; repo:src/resize.js:2; 2026-11-16].

**Suggested approach [Suggestion — implementer may choose otherwise]:** process files sequentially to bound memory; use a client-side ZIP library after a licence check.

## 10. Acceptance criteria

| ID | Covers | Criterion |
|---|---|---|
| AC-1 | FR-1 | **Given** three images are dropped **When** the list renders **Then** three entries appear with file names |
| AC-2 | FR-2, FR-3 | **Given** width 800 and WebP are selected **When** the user clicks Download ZIP **Then** the ZIP contains three WebP files, each 800 px wide |
| AC-3 | FR-4 | **Given** batch processing runs **When** network activity is inspected **Then** no requests carry image data |
| AC-4 | NFR-2 | **Given** 50 files of 5 MB **When** processing completes **Then** the page has not crashed and all outputs are in the ZIP |

## 11. Edge cases

- A non-image file in the batch is skipped and listed as skipped.
- Duplicate file names get a numeric suffix in the ZIP.

## 12. Error and failure scenarios

- Decoding fails for one file → that file is reported failed, others continue, ZIP contains the successes.

## 13. Security and privacy considerations

No new data leaves the browser (FR-4). The ZIP library must be reviewed for licence and supply-chain risk.

## 14. Out of scope

- Server-side processing, accounts, per-file settings, EXIF handling (OPP-002 is deferred).

## 15. Dependencies

- A client-side ZIP library (candidate, unapproved).

## 16. Success metrics

| Metric | Baseline | Target | Measurement |
|---|---|---|---|
| Share of sessions processing 2+ files | unknown | set by the owner after launch | client-side counter, if the owner approves analytics |

## 17. Research references

- Originating opportunity: OPP-001
- ShrinkRay offers batch of 50 files [E: fact; high; https://example.com/shrinkray/pricing; 2026-11-16]

## 18. Unresolved decisions

- Is analytics acceptable given the no-upload positioning? Needed for the success metric, not for implementation.

## 19. Implementation handoff

- **Product baseline:** PRODUCT.md revision 1
- **Read first:** src/app.js, src/resize.js
- **Definition of done:** all acceptance criteria pass; no out-of-scope work; no new unresolved decisions invented.
- **Questions go to:** the user, via the implementation agent. Do not guess requirements.
- **Suggested verification:** AC-1..AC-4 as browser tests.
