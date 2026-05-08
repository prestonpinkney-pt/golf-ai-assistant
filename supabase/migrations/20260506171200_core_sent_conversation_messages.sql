-- Core CloseOS conversational agent messages table.
-- Supabase is the source of truth; Sent.dm is only the messaging rail.

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  contact_phone text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null default 'rcs',
  provider text not null default 'sent',
  body text not null,
  status text,
  provider_message_id text,
  created_at timestamptz not null default now()
);

-- If `messages` already existed from earlier CloseOS iterations, add the
-- core agent fields without removing legacy conversation columns.
alter table public.messages
  add column if not exists contact_phone text,
  add column if not exists provider text default 'sent',
  add column if not exists body text,
  add column if not exists provider_message_id text;

create index if not exists messages_contact_phone_created_idx
  on public.messages (contact_phone, created_at desc);

create index if not exists messages_provider_message_id_idx
  on public.messages (provider_message_id)
  where provider_message_id is not null;

comment on table public.messages is
  'Canonical CloseOS customer conversation history. Sent.dm does not own conversation state.';
