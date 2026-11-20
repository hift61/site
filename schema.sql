create table if not exists public.wf_cases(id text primary key, payload jsonb not null);
create table if not exists public.wf_runs(id uuid primary key, created_at timestamptz not null default now(), payload jsonb not null);
alter table public.wf_cases enable row level security;
alter table public.wf_runs enable row level security;
revoke all on public.wf_cases, public.wf_runs from anon, authenticated;
grant select,insert on public.wf_cases, public.wf_runs to service_role;
