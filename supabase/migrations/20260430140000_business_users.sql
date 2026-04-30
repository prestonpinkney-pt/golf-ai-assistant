-- CloseOS workspace membership (allowlisted Supabase Auth users per business)

create table if not exists public.business_users (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  user_id uuid not null,
  email text not null,
  role text not null default 'operator',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, user_id)
);

create index if not exists business_users_user_idx
  on public.business_users (user_id, active);

create index if not exists business_users_business_idx
  on public.business_users (business_id, active);

comment on table public.business_users is 'Maps Supabase auth users to a CloseOS business; enforced in app layer with service role after JWT validation.';
