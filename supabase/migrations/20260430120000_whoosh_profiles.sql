-- Whoosh roster staging + identity (run in Supabase SQL editor or via CLI)

create table if not exists public.whoosh_profiles (
  id uuid primary key default gen_random_uuid(),

  business_id uuid not null,

  source text not null default 'whoosh_roster',
  external_id text not null,

  first_name text,
  last_name text,
  full_name text,

  email text,
  phone text,

  customer_type text,
  is_member boolean not null default false,
  membership_name text,

  date_of_birth text,

  raw_payload jsonb not null default '{}'::jsonb,

  matched_customer_profile_id uuid references public.customer_profiles(id) on delete set null,
  match_method text,
  match_confidence integer,

  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id, source, external_id)
);

create index if not exists whoosh_profiles_business_idx
  on public.whoosh_profiles (business_id);

create index if not exists whoosh_profiles_email_idx
  on public.whoosh_profiles (business_id, lower(email));

create index if not exists whoosh_profiles_phone_idx
  on public.whoosh_profiles (business_id, phone);

create index if not exists whoosh_profiles_member_idx
  on public.whoosh_profiles (business_id, is_member);
