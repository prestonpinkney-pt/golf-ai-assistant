-- CloseOS opportunity truth layer: honest pipeline vs qualified leads vs review/data quality.
alter table public.ai_opportunities
  add column if not exists revenue_review_required boolean not null default false;

alter table public.ai_opportunities
  add column if not exists counts_toward_pipeline boolean not null default true;

alter table public.ai_opportunities
  add column if not exists offer_key text null;

alter table public.ai_opportunities
  add column if not exists pipeline_category text null;

comment on column public.ai_opportunities.revenue_review_required is
  'When true, UI shows Revenue TBD; do not count cents toward known pipeline until configured.';

comment on column public.ai_opportunities.counts_toward_pipeline is
  'When false, exclude from known pipeline dollar totals.';

comment on column public.ai_opportunities.offer_key is
  'Maps to CLOSEOS_BUSINESS_OFFERS in app code.';

comment on column public.ai_opportunities.pipeline_category is
  'known_pipeline | qualified_lead | review_only | data_quality';
