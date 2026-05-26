-- Whoosh availability cache for CloseOS campaign + slow-time opportunity generation.

create table if not exists public.whoosh_availability_windows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  whoosh_window_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/Los_Angeles',
  resource_id text,
  resource_name text,
  resource_type text not null default 'unknown',
  bookable boolean not null default true,
  capacity integer,
  raw jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whoosh_availability_windows_business_idx
  on public.whoosh_availability_windows (business_id);

create index if not exists whoosh_availability_windows_starts_at_idx
  on public.whoosh_availability_windows (starts_at);

create index if not exists whoosh_availability_windows_resource_type_idx
  on public.whoosh_availability_windows (resource_type);

create index if not exists whoosh_availability_windows_bookable_idx
  on public.whoosh_availability_windows (bookable);

create unique index if not exists whoosh_availability_windows_business_window_uidx
  on public.whoosh_availability_windows (business_id, whoosh_window_id);

comment on table public.whoosh_availability_windows is
  'Cached Whoosh bookable windows — source of truth for slow-time/simulator campaigns.';

alter table public.ai_opportunities
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.ai_opportunities.metadata is
  'Structured CloseOS fields (e.g. Whoosh availability verification for slow-time campaigns).';
