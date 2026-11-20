begin;

create table if not exists public.wf_media (
  id uuid primary key,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 50000000),
  created_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'uploaded', 'draft', 'evaluated')),
  revision integer not null default 0,
  evaluation jsonb
);

alter table public.wf_media add column if not exists measurement_csv text;
alter table public.wf_media add column if not exists measurement_summary jsonb;

alter table public.wf_media enable row level security;
revoke all on public.wf_media from anon, authenticated;
grant select, insert, update on public.wf_media to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('waterful-media', 'waterful-media', false, 50000000,
  array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false;

commit;

-- Register one case per capture. Keep the revision check and write in one transaction.
begin;

grant update on public.wf_cases to service_role;

create or replace function public.wf_register_tracked_case(
  p_media uuid, p_revision integer, p_case text, p_payload jsonb
) returns text
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.wf_media
    where id = p_media and revision = p_revision and status = 'evaluated'
      and measurement_summary->>'case_id' = p_case
    for update;
  if not found then
    return 'stale';
  end if;

  insert into public.wf_cases (id, payload)
    values (p_case, p_payload)
    on conflict (id) do update
      set payload = excluded.payload
      where public.wf_cases.payload->>'source_media_id' = p_media::text;
  if not found then
    return 'duplicate';
  end if;
  return 'saved';
end;
$$;

revoke all on function public.wf_register_tracked_case(uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.wf_register_tracked_case(uuid, integer, text, jsonb) to service_role;
commit;
