-- CloseOS outbound campaign ledger: draft → approve → send batches (operator-gated).

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  name text not null,
  campaign_type text not null default 'outbound_sms',
  playbook_key text null,
  status text not null default 'draft',
  source text not null default 'opportunity_playbook',
  total_recipients integer not null default 0,
  total_drafted integer not null default 0,
  total_approved integer not null default 0,
  total_sent integer not null default 0,
  total_failed integer not null default 0,
  created_by uuid null,
  approved_at timestamptz null,
  sent_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_business_created_idx
  on public.campaigns (business_id, created_at desc);

create table if not exists public.campaign_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  opportunity_id uuid null,
  phone text null,
  contact_name text null,
  message_text text not null default '',
  status text not null default 'draft',
  delivery_status text null,
  external_id text null,
  contact_id uuid null,
  conversation_id uuid null,
  approved_at timestamptz null,
  sent_at timestamptz null,
  failed_at timestamptz null,
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_messages_campaign_idx
  on public.campaign_messages (campaign_id, created_at asc);

create index if not exists campaign_messages_status_idx
  on public.campaign_messages (campaign_id, status);

comment on table public.campaigns is
  'Operator-reviewed outbound SMS batches; nothing sends until approve + explicit send.';

comment on table public.campaign_messages is
  'Per-recipient draft/approved/sent rows for a campaign batch.';
