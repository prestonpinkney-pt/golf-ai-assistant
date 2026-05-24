-- Reclaim webhook_jobs stuck in `processing` (e.g. after() timeout) so cron can retry.

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
    attempts = j.attempts + 1,
    updated_at = now()
  from picked
  where j.id = picked.id
  returning j.*;
end;
$$;

comment on function public.claim_webhook_jobs_batch(integer) is
  'Claims pending or stale processing webhook_jobs rows (SKIP LOCKED); service_role only.';
