# CloseOS Build Tracker

## Day 1 — Project Setup
- [x] Section 1 — Project Structure
- [x] Section 2 — Environment Variables
- [x] Section 3 — Supabase Setup
- [x] Section 4 — Build Tracker
- [x] Section 5 — Naming Consistency
- [ ] Section 6 — System Flow

## Day 2 — Database Schema
- [x] workspaces
- [x] users
- [x] contacts
- [x] channel_identities
- [x] consent_records
- [x] leads
- [x] conversations
- [x] messages
- [x] inbound_events
- [x] audit_events

## Day 3 — Business Truth Tables
- [x] knowledge_items
- [x] booking_intents
- [x] booking_outcomes
- [x] campaigns
- [x] campaign_steps
- [x] integration_connections

## Day 4 — Inbound Event Pipeline Base
- [x] inbound event insert flow
- [x] status lifecycle
- [x] error_message + error_source
- [x] retry_count
- [x] normalized_event_id
## Day 4 Rule
Every inbound event must be inserted into `inbound_events` before any processing happens.
Inbound event lifecycle:
received → processed / failed / ignored
## Day 5 — Contact + Lead Services
- [x] contact lookup by phone
- [x] contact lookup by email
- [x] contact create flow
- [x] lead create/update flow
- [x] conversation create/update flow

## Day 6 — Message + Audit System
- [x] inbound message storage
- [x] outbound message storage
- [x] audit event logging
- [x] conversation threading logic

## Day 7 — Review
- [x] review schema
- [x] remove unnecessary complexity
- [x] test sample inserts
- [x] confirm naming consistency

## Day 8 — Website Intake + Trigger Setup
- [x] inbound API route created
- [x] inbound event save works
- [x] contact creation works
- [x] lead creation works
- [x] conversation creation works
- [x] message save works
- [x] audit log works

## AI Response Route Rules
- AI reads the latest inbound message from the conversation
- AI selects a playbook based on message content
- AI generates one purposeful response
- AI saves the response as an outbound message
- AI logs the action in audit_logs

Day 1 Notes
## CloseOS Core Flow

Inbound → Event → Contact → Lead → Conversation → Message → AI → Action
\Rule 1
Nothing skips inbound_events
Rule 2
Every real person becomes a contact
Rule 3
Every opportunity becomes a lead
Rule 4
Every active interaction lives in a conversation
Rule 5
Every actual communication gets stored as a message
Rule 6
AI only acts after the system has context

## Inbound Processing Rules

- All inbound events are saved first
- Events start as "received"
- Events must end as processed / failed / ignored
- Failed events must include error_message and error_source
- retry_count starts at 0
- normalized_event_id starts null

## Conversation Rule
- Each contact should have one active conversation
- Messages are attached to conversations
- AI reads and responds from the conversation thread

## Day 5 Flow

1. inbound_event is received
2. extract phone/email
3. find or create contact
4. create or update lead
5. create or resume conversation
6. AI reads conversation and responds


## Conversation States

- new_inquiry
- qualifying
- ready_to_book
- booked
- cooling_off
- closed

## Reliability + Maintainability Improvement Plan

### How to use this section
- Severity: `P0` (critical), `P1` (high), `P2` (medium)
- Each item includes:
  - Risk
  - Implementation checklist
  - Definition of done

### 1) Remove hardcoded business constants (`P0`)
- Risk: Single-tenant assumptions are spread across routes, making behavior brittle and hard to scale.
- Implementation checklist:
  - [ ] Create `config/constants.ts` as the single source for business IDs/slugs.
  - [ ] Add `getBusinessContext()` helper in API shared libs.
  - [ ] Replace inline business constants in all API routes with shared context lookup.
  - [ ] Add runtime guard that throws clear error if required business config is missing.
- Definition of done:
  - [ ] No hardcoded business IDs/slugs remain in `app/api/**`.
  - [ ] All affected routes resolve tenant/business config from one shared helper.

### 2) Eliminate duplicate route logic (`P1`)
- Risk: Overlapping handlers drift over time and produce inconsistent behavior.
- Implementation checklist:
  - [ ] Identify duplicate route pairs and document canonical owner for each behavior.
  - [ ] Extract shared domain functions to `app/api/services/**`.
  - [ ] Keep route handlers thin (validation/auth + service call + response mapping).
  - [ ] Remove deprecated duplicate paths after parity validation.
- Definition of done:
  - [ ] One canonical implementation per domain behavior.
  - [ ] No duplicated business logic blocks across route handlers.

### 3) Standardize persistence on Supabase (`P0`)
- Risk: Mixed JSON + Supabase persistence causes split-brain data and operational confusion.
- Implementation checklist:
  - [ ] Inventory file-backed endpoints (`data/*.json` usage) and map them to Supabase tables.
  - [ ] Create migration scripts to backfill JSON records into Supabase.
  - [ ] Switch file-backed endpoints to read/write Supabase.
  - [ ] Deprecate JSON files and remove write access paths.
- Definition of done:
  - [ ] No production API route writes to local JSON files.
  - [ ] Reconciliation check confirms migrated record counts match source files.

### 4) Unify messaging provider interface (`P1`)
- Risk: Twilio + Sent.dm paths in parallel increase complexity and delivery-status mismatch risk.
- Implementation checklist:
  - [ ] Define single messaging adapter contract (`send`, `normalizeWebhook`, `statusMap`).
  - [ ] Route all outbound sends through shared adapter entrypoint.
  - [ ] Normalize webhook payloads to one internal event schema.
  - [ ] Document primary vs fallback provider policy.
- Definition of done:
  - [ ] Outbound routes call one adapter interface, not provider-specific logic directly.
  - [ ] Delivery statuses are normalized to one internal status model.

### 5) Remove test-like hardcoded values from runtime flows (`P0`)
- Risk: Hardcoded test numbers/IDs can trigger production mistakes.
- Implementation checklist:
  - [ ] Move all test defaults to environment variables.
  - [ ] Add production guardrails that reject known test values.
  - [ ] Add CI check to block committed test literals in runtime API code.
- Definition of done:
  - [ ] No hardcoded test phone/email/ID literals remain in operational routes.
  - [ ] CI fails when new test literals are introduced.

### Suggested execution order
1. Remove test-like hardcoded values (`P0`)
2. Standardize business config lookup (`P0`)
3. Consolidate persistence to Supabase (`P0`)
4. Unify messaging adapter (`P1`)
5. Collapse duplicate route logic (`P1`)