-- webhook_jobs contains inbound message payloads and is processed only by service-role workers.
alter table public.webhook_jobs enable row level security;

revoke all on table public.webhook_jobs from public, anon, authenticated;
grant all on table public.webhook_jobs to service_role;

revoke execute on function public.begin_webhook_job(uuid)
  from public, anon, authenticated;
revoke execute on function public.claim_webhook_jobs_batch(integer)
  from public, anon, authenticated;

grant execute on function public.begin_webhook_job(uuid) to service_role;
grant execute on function public.claim_webhook_jobs_batch(integer) to service_role;
