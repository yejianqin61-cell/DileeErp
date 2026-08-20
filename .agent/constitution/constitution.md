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

1. The ERP follows the principle of reversible progress: a permitted correction must preserve the original fact, editor, time, reason, and before/after values. It must never silently overwrite history.
2. Before an edit that affects upstream or downstream records, show the operator the affected records, recalculated quantities or amounts, state changes, warnings, and remaining risks. The operator must explicitly confirm the impact.
3. After confirmation, update or recalculate derived records in the same business transaction. An independent downstream fact must not be overwritten; preserve its source link and require a reversal, adjustment, or review record instead.
4. Inventory designs must distinguish static inventory records from dynamic transaction documents. Inventory balances are derived from effective transactions and adjustments, never directly edited.
5. Module designs define detailed edit scopes, returns, reversals, warnings, and reconciliation rules. Unconfirmed rules stay in `docs/memo/`.

## Configurable Business Categories

1. Business form types, categories, adjustment items, departments, positions, employee types, attendance types, and other non-invariant classifications must be configurable through management interfaces.
2. Administrators may add, edit, disable, or logically delete configurable categories. A category already used by business data must be retained as a historical snapshot and normally disabled instead of removed.
3. Configurability does not weaken fixed data integrity rules: required source links, audit records, state transitions, financial balances, and inventory facts remain protected by the relevant module rules.
