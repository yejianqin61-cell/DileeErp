# Dilee ERP Agent Constitution

## Decision Traceability

1. Every product, architecture, data model, API, security, deployment, and implementation decision must be recorded before or in the same change that implements it.
2. The record must state the decision, its scope, rationale, source or decision maker when known, and unresolved assumptions.
3. Product-wide decisions belong in `docs/product/`; technical designs and implementation plans belong in `docs/design/`; executable work is decomposed into `docs/task/` documents.
4. Agents must not silently introduce a decision that changes an agreed rule. They must update the relevant document and daily development log first.
5. Every development day must have a log entry in `docs/log/YYYY-MM-DD.md`. The entry records completed work, decisions, verification, open questions, and the next intended step.
6. Existing decisions remain traceable. When a decision changes, append a superseding record rather than rewriting history without explanation.

## Development Discipline

1. Build only confirmed business rules. Record unconfirmed module details in `docs/memo/` or the corresponding design document.
2. Before implementing a business module, create or update its module specification and task document.
3. Verify code changes with the narrowest meaningful automated check and record the result in the daily log.

## Reversible Business Changes

1. The ERP must provide a recoverable correction path for business data. A permitted correction must preserve the original business fact, the editor, time, reason, and before/after values; it must not silently overwrite history.
2. Before a change that can affect upstream or downstream records, the system must identify the affected records and present the resulting recalculation, state impact, and unresolved risk to the operator. The operator must explicitly confirm the change after seeing that impact.
3. After confirmation, related derived data, statuses, warnings, balances, and reports must be recalculated or marked for review in the same business transaction. The system must never leave dependent records silently stale.
4. Where a downstream record is an independent business fact, it must not be rewritten by an upstream edit. Keep its source linkage, raise a discrepancy or review warning, and use a separate reversal or adjustment record when correction is needed.
5. The detailed impact rules, allowed edit scopes, warnings, and reversal actions belong to each module design. Unconfirmed rules remain in `docs/memo/`.
