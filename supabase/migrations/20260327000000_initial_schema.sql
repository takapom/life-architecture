-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- profiles: linked to auth.users
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  github_username text not null,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- diagnoses
create table if not exists public.diagnoses (
  id                   uuid primary key default uuid_generate_v4(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  submission_id        uuid not null unique,
  paired_diagnosis_id  uuid unique references public.diagnoses(id),
  phase_label          text not null,
  phase_type           text not null check (phase_type in ('current', 'past')),
  answers              jsonb not null,
  created_at           timestamptz not null default now()
);

alter table public.diagnoses enable row level security;

create policy "Users can view own diagnoses"
  on public.diagnoses for select
  using (auth.uid() = user_id);

create policy "Users can insert own diagnoses"
  on public.diagnoses for insert
  with check (auth.uid() = user_id);

-- diagnosis_results
create table if not exists public.diagnosis_results (
  id                 uuid primary key default uuid_generate_v4(),
  diagnosis_id       uuid not null unique references public.diagnoses(id) on delete cascade,
  architecture_name  text not null,
  description        text not null,
  scores             jsonb not null,
  diagram_data       jsonb not null,
  created_at         timestamptz not null default now()
);

alter table public.diagnosis_results enable row level security;

-- Results are public (for share URLs)
create policy "Results are publicly readable"
  on public.diagnosis_results for select
  using (true);

-- INSERT is handled exclusively via service_role key in API routes (bypasses RLS).
-- No anon/authenticated INSERT policy needed.

-- Auto-create profile on first login
create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, github_username, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data->>'user_name',
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
