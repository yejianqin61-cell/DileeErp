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
