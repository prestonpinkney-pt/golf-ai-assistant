-- Canonical conversation messaging fields for CloseOS.
-- `messages` is the source of truth for customer conversation messages.

alter table public.messages
  add column if not exists provider text,
  add column if not exists external_id text,
  add column if not exists delivery_status text,
  add column if not exists delivery_updated_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists ai_generated boolean not null default false,
  add column if not exists ai_model text,
  add column if not exists ai_confidence numeric,
  add column if not exists intent text,
  add column if not exists risk_level text,
  add column if not exists escalation_required boolean not null default false,
  add column if not exists escalation_reason text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists messages_external_id_idx
  on public.messages (external_id)
  where external_id is not null;

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

create index if not exists messages_escalation_required_idx
  on public.messages (escalation_required)
  where escalation_required = true;

alter table public.conversations
  add column if not exists last_message_at timestamptz,
  add column if not exists last_inbound_at timestamptz,
  add column if not exists last_outbound_at timestamptz,
  add column if not exists needs_human boolean not null default false,
  add column if not exists human_reason text;

create index if not exists conversations_needs_human_idx
  on public.conversations (needs_human)
  where needs_human = true;

comment on column public.messages.external_id is
  'Provider message id. Sent.dm delivery webhooks reconcile against this field first.';

comment on column public.messages.ai_confidence is
  'Structured AI response confidence from 0 to 1.';

comment on column public.conversations.needs_human is
  'True when the latest automation decision escalated this conversation to an operator.';
