-- Keep Sent.dm inbound webhook processing retryable after transient failures.

create or replace function public.begin_webhook_job(p_id uuid)
returns setof public.webhook_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select j.id
    from public.webhook_jobs j
    where j.id = p_id
      and (
        j.status = 'pending'
        or (j.status = 'failed' and coalesce(j.attempts, 0) < 5)
        or (
          j.status = 'processing'
          and j.updated_at < now() - interval '15 minutes'
        )
      )
    limit 1
    for update skip locked
  )
  update public.webhook_jobs j
  set
    status = 'processing',
    attempts = coalesce(j.attempts, 0) + 1,
    last_error = null,
    processed_at = null,
    updated_at = now()
  from picked
  where j.id = picked.id
  returning j.*;
end;
$$;

comment on function public.begin_webhook_job(uuid) is
  'Claims one pending, failed-with-retries-left, or stale processing webhook_jobs row (SKIP LOCKED); service_role only.';

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
       or (j.status = 'failed' and coalesce(j.attempts, 0) < 5)
       or (
         j.status = 'processing'
         and j.updated_at < now() - interval '15 minutes'
       )
    order by j.created_at asc
    limit lim
    for update skip locked
  )
  update public.webhook_jobs j
  set
    status = 'processing',
    attempts = coalesce(j.attempts, 0) + 1,
    last_error = null,
    processed_at = null,
    updated_at = now()
  from picked
  where j.id = picked.id
  returning j.*;
end;
$$;

comment on function public.claim_webhook_jobs_batch(integer) is
  'Claims pending, failed-with-retries-left, or stale processing webhook_jobs rows (SKIP LOCKED); service_role only.';
