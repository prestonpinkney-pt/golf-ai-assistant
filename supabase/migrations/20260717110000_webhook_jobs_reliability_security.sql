-- Ensure webhook jobs are durable, retryable, and service-role-only.

create table if not exists public.webhook_jobs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  external_id text,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.webhook_jobs
  add column if not exists provider text,
  add column if not exists event_type text,
  add column if not exists external_id text,
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists status text not null default 'pending',
  add column if not exists attempts integer not null default 0,
  add column if not exists last_error text,
  add column if not exists processed_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists webhook_jobs_provider_external_id_key
  on public.webhook_jobs (provider, external_id)
  where external_id is not null;

create index if not exists webhook_jobs_claim_idx
  on public.webhook_jobs (status, created_at);

alter table public.webhook_jobs enable row level security;

create or replace function public.begin_webhook_job(p_id uuid)
returns setof public.webhook_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.webhook_jobs j
  set
    status = 'processing',
    attempts = j.attempts + 1,
    updated_at = now()
  where j.id = p_id
    and j.status = 'pending'
  returning j.*;
end;
$$;

create or replace function public.claim_webhook_jobs_batch(p_limit integer default 10)
returns setof public.webhook_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  lim integer := greatest(1, least(coalesce(p_limit, 10), 50));
begin
  return query
  with picked as (
    select j.id
    from public.webhook_jobs j
    where j.status = 'pending'
       or (
         j.status = 'failed'
         and j.attempts < 5
       )
       or (
         j.status = 'processing'
         and j.updated_at < now() - interval '15 minutes'
         and j.attempts < 5
       )
    order by j.created_at asc
    limit lim
    for update skip locked
  )
  update public.webhook_jobs j
  set
    status = 'processing',
    attempts = j.attempts + 1,
    updated_at = now()
  from picked
  where j.id = picked.id
  returning j.*;
end;
$$;

comment on function public.claim_webhook_jobs_batch(integer) is
  'Claims pending, bounded failed retries, or stale processing webhook_jobs rows (SKIP LOCKED); service_role only.';

revoke all on table public.webhook_jobs from public, anon, authenticated;
grant all on table public.webhook_jobs to service_role;

revoke all on function public.begin_webhook_job(uuid) from public, anon, authenticated;
grant execute on function public.begin_webhook_job(uuid) to service_role;

revoke all on function public.claim_webhook_jobs_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_webhook_jobs_batch(integer) to service_role;
