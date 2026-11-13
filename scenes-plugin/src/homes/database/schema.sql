-- Kurviq's tables in your own Supabase project (https://kurviq.com).
--
-- Run it in the project's SQL editor (or let "Connect with Supabase" run it).
-- Safe to run again: it creates what is missing and replaces Kurviq's
-- functions and policies. Nothing outside the kurviq_* tables, functions and
-- policies (and the storage bucket "kurviq-files") is touched.
--
-- Who may do what is decided here, by row-level security, against the
-- signed-in person's email address: the space's members (owner, editor,
-- commenter, viewer), per-scene access on top (with an optional end date),
-- and scenes made public (anyone with the link may view them).

set client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------

create table if not exists public.kurviq_space (
  id smallint primary key default 1 check (id = 1),
  name text not null default 'Team space' check (char_length(name) between 1 and 100),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
insert into public.kurviq_space (id) values (1) on conflict (id) do nothing;

create table if not exists public.kurviq_members (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  role text not null check (role in ('owner', 'editor', 'commenter', 'viewer')),
  invited_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.kurviq_scenes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  public text not null default 'none' check (public in ('none', 'view')),
  revision bigint not null default 1,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  moved_to jsonb
);
create unique index if not exists kurviq_scenes_name on public.kurviq_scenes (name) where deleted_at is null and moved_to is null;

create table if not exists public.kurviq_scene_access (
  scene_id uuid not null references public.kurviq_scenes (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  role text not null check (role in ('editor', 'commenter', 'viewer')),
  expires_at timestamptz,
  invited_by text,
  created_at timestamptz not null default now(),
  primary key (scene_id, email)
);

-- one row per element: two people changing different elements never touch
-- the same row; the same element: the higher version wins (as in Excalidraw)
create table if not exists public.kurviq_elements (
  scene_id uuid not null references public.kurviq_scenes (id) on delete cascade,
  id text not null,
  version integer not null,
  version_nonce bigint not null default 0,
  pos double precision not null default 0,
  data json not null,
  rev bigint not null default 0,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (scene_id, id)
);
create index if not exists kurviq_elements_rev on public.kurviq_elements (scene_id, rev);

-- the rest of the scene file (background, grid, presentation, fonts) and its pictures' index
create table if not exists public.kurviq_scene_meta (
  scene_id uuid primary key references public.kurviq_scenes (id) on delete cascade,
  envelope json not null default '{}'::json,
  files jsonb not null default '{}'::jsonb,
  rev bigint not null default 0,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- comments in the shape of the scene file's kurviqComments (one row per comment or reply)
create table if not exists public.kurviq_comments (
  scene_id uuid not null references public.kurviq_scenes (id) on delete cascade,
  id text not null,
  data jsonb not null,
  rev bigint not null default 0,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (scene_id, id)
);
create index if not exists kurviq_comments_rev on public.kurviq_comments (scene_id, rev);

-- milestones: whole scenes, kept as they were
create table if not exists public.kurviq_versions (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references public.kurviq_scenes (id) on delete cascade,
  revision bigint not null,
  name text,
  snapshot json not null,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists kurviq_versions_scene on public.kurviq_versions (scene_id, created_at desc);

-- ---------------------------------------------------------------------------
-- who is asking, and what they may do
-- ---------------------------------------------------------------------------

create or replace function public.kurviq_schema_version() returns integer
language sql immutable as $$ select 1 $$;

create or replace function public.kurviq_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.kurviq_rank(role text) returns integer
language sql immutable as $$
  select case role when 'owner' then 4 when 'editor' then 3 when 'commenter' then 2 when 'viewer' then 1 else 0 end
$$;

create or replace function public.kurviq_uuid(value text) returns uuid
language plpgsql immutable as $$
begin
  return value::uuid;
exception when others then
  return null;
end $$;

create or replace function public.kurviq_space_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.kurviq_members m where m.email = public.kurviq_email() and public.kurviq_email() <> ''
$$;

-- the higher of the space role and an unexpired access to this scene
create or replace function public.kurviq_scene_role(scene uuid) returns text
language sql stable security definer set search_path = '' as $$
  select r.role from (
    select m.role from public.kurviq_members m where m.email = public.kurviq_email()
    union all
    select a.role from public.kurviq_scene_access a
      where a.scene_id = scene and a.email = public.kurviq_email() and (a.expires_at is null or a.expires_at > now())
  ) r
  where public.kurviq_email() <> ''
  order by public.kurviq_rank(r.role) desc
  limit 1
$$;

create or replace function public.kurviq_can_read(scene uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.kurviq_scene_role(scene) is not null
    or exists (select 1 from public.kurviq_scenes s where s.id = scene and s.public = 'view' and s.deleted_at is null and s.moved_to is null)
$$;

create or replace function public.kurviq_can_edit(scene uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.kurviq_rank(public.kurviq_scene_role(scene)) >= 3
    and exists (select 1 from public.kurviq_scenes s where s.id = scene and s.deleted_at is null and s.moved_to is null)
$$;

create or replace function public.kurviq_can_comment(scene uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.kurviq_rank(public.kurviq_scene_role(scene)) >= 2
$$;

-- the key that marks a person's comments as theirs (scenes-mcp/sceneComments.mjs authorKey)
create or replace function public.kurviq_author_key(email text) returns text
language sql immutable as $$
  select encode(substring(sha256(convert_to('kurviq-comment:' || lower(trim(email)), 'UTF8')) from 1 for 8), 'hex')
$$;

-- the first person to sign in to a space without an owner becomes its owner
create or replace function public.kurviq_claim_space(space_name text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me text := public.kurviq_email();
begin
  if me = '' then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.kurviq_members where role = 'owner') then
    insert into public.kurviq_members (email, role) values (me, 'owner')
      on conflict (email) do update set role = 'owner';
    if space_name is not null and char_length(trim(space_name)) > 0 then
      update public.kurviq_space set name = left(trim(space_name), 100) where id = 1;
    end if;
  end if;
  return public.kurviq_space_role();
end $$;

-- ---------------------------------------------------------------------------
-- revisions and announcements: every change of a scene's content bumps its
-- revision; the database tells the scene's realtime channel (private topic
-- "kurviq:<scene id>") which revision it is at
-- ---------------------------------------------------------------------------

create or replace function public.kurviq_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.kurviq_scenes set revision = revision + 1, updated_at = now(), updated_by = public.kurviq_email()
    where id = new.scene_id
    returning revision into new.rev;
  new.updated_by := public.kurviq_email();
  new.updated_at := now();
  return new;
end $$;

-- the same element: only a newer version is taken (higher version; the same
-- version: the lower nonce, as in Excalidraw). A whole-scene save
-- (kurviq_save_scene, its base checked) is taken anyway, as a newer version.
create or replace function public.kurviq_newer_element() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.version > old.version or (new.version = old.version and new.version_nonce < old.version_nonce) then
    return new;
  end if;
  if current_setting('kurviq.whole_save', true) = 'on' and (new.data::text <> old.data::text or new.pos <> old.pos) then
    new.version := old.version + 1;
    new.data := jsonb_set(new.data::jsonb, '{version}', to_jsonb(new.version))::json;
    return new;
  end if;
  return null;
end $$;

create or replace function public.kurviq_announce() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  changed_scene record;
begin
  for changed_scene in select c.scene_id, max(c.rev) as rev from changed c group by c.scene_id loop
    begin
      perform realtime.send(
        jsonb_build_object('rev', changed_scene.rev, 'table', tg_table_name, 'by', public.kurviq_email()),
        'changed', 'kurviq:' || changed_scene.scene_id::text, true);
    exception when others then
      null; -- no realtime here (self-hosted without it): others see the change at their next load
    end;
  end loop;
  return null;
end $$;

create or replace function public.kurviq_announce_scene() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('name', new.name, 'public', new.public, 'deleted', new.deleted_at is not null, 'moved', new.moved_to),
      'scene', 'kurviq:' || new.id::text, true);
  exception when others then
    null;
  end;
  return null;
end $$;

-- what a commenter may change (scenes-mcp/sceneComments.mjs commenterRefusal);
-- editors any comment; the newer change (u) wins
create or replace function public.kurviq_comment_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rank integer := public.kurviq_rank(public.kurviq_scene_role(new.scene_id));
  me text := public.kurviq_author_key(public.kurviq_email());
  author text;
begin
  if coalesce(auth.role(), '') <> 'service_role' and rank < 3 then
    if rank < 2 then
      raise exception 'You may not comment on this scene' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' then
      if (new.data -> 'by' ->> 'key') is distinct from me then
        raise exception 'A new comment must be the commenter''s own' using errcode = '42501';
      end if;
      if coalesce((new.data ->> 'gone')::boolean, false) then
        raise exception 'Nothing to delete' using errcode = '42501';
      end if;
    else
      author := old.data -> 'by' ->> 'key';
      if (old.data ->> 'thread') is distinct from (new.data ->> 'thread')
        or (old.data -> 'at') is distinct from (new.data -> 'at')
        or author is distinct from (new.data -> 'by' ->> 'key') then
        raise exception 'A comment''s thread, time and author stay' using errcode = '42501';
      end if;
      if (old.data -> 'pin') is distinct from (new.data -> 'pin') and author is distinct from me then
        raise exception 'Only the author moves a pin' using errcode = '42501';
      end if;
      if author is distinct from me and (
        (old.data ->> 'text') is distinct from (new.data ->> 'text')
        or coalesce((old.data ->> 'gone')::boolean, false) <> coalesce((new.data ->> 'gone')::boolean, false)
        or (old.data -> 'by' ->> 'name') is distinct from (new.data -> 'by' ->> 'name')
        or coalesce((old.data -> 'by' ->> 'agent')::boolean, false) <> coalesce((new.data -> 'by' ->> 'agent')::boolean, false)
        or (old.data -> 'edited') is distinct from (new.data -> 'edited')) then
        raise exception 'Only the author edits or deletes a comment' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and coalesce((new.data ->> 'u')::numeric, 0) <= coalesce((old.data ->> 'u')::numeric, 0) then
    return null; -- an older change than the stored one
  end if;
  return new;
end $$;

drop trigger if exists kurviq_a_newer on public.kurviq_elements;
create trigger kurviq_a_newer before update on public.kurviq_elements
  for each row execute function public.kurviq_newer_element();
drop trigger if exists kurviq_b_stamp on public.kurviq_elements;
create trigger kurviq_b_stamp before insert or update on public.kurviq_elements
  for each row execute function public.kurviq_stamp();
drop trigger if exists kurviq_announce_insert on public.kurviq_elements;
create trigger kurviq_announce_insert after insert on public.kurviq_elements
  referencing new table as changed for each statement execute function public.kurviq_announce();
drop trigger if exists kurviq_announce_update on public.kurviq_elements;
create trigger kurviq_announce_update after update on public.kurviq_elements
  referencing new table as changed for each statement execute function public.kurviq_announce();

drop trigger if exists kurviq_a_check on public.kurviq_comments;
create trigger kurviq_a_check before insert or update on public.kurviq_comments
  for each row execute function public.kurviq_comment_check();
drop trigger if exists kurviq_b_stamp on public.kurviq_comments;
create trigger kurviq_b_stamp before insert or update on public.kurviq_comments
  for each row execute function public.kurviq_stamp();
drop trigger if exists kurviq_announce_insert on public.kurviq_comments;
create trigger kurviq_announce_insert after insert on public.kurviq_comments
  referencing new table as changed for each statement execute function public.kurviq_announce();
drop trigger if exists kurviq_announce_update on public.kurviq_comments;
create trigger kurviq_announce_update after update on public.kurviq_comments
  referencing new table as changed for each statement execute function public.kurviq_announce();

drop trigger if exists kurviq_b_stamp on public.kurviq_scene_meta;
create trigger kurviq_b_stamp before insert or update on public.kurviq_scene_meta
  for each row execute function public.kurviq_stamp();
drop trigger if exists kurviq_announce_insert on public.kurviq_scene_meta;
create trigger kurviq_announce_insert after insert on public.kurviq_scene_meta
  referencing new table as changed for each statement execute function public.kurviq_announce();
drop trigger if exists kurviq_announce_update on public.kurviq_scene_meta;
create trigger kurviq_announce_update after update on public.kurviq_scene_meta
  referencing new table as changed for each statement execute function public.kurviq_announce();

drop trigger if exists kurviq_announce on public.kurviq_scenes;
create trigger kurviq_announce after update of name, public, deleted_at, moved_to on public.kurviq_scenes
  for each row execute function public.kurviq_announce_scene();

-- ---------------------------------------------------------------------------
-- writes in one call (row-level security applies: they run as the caller)
-- ---------------------------------------------------------------------------

-- elements changed in the editor: each is taken if it is newer; the scene's revision
create or replace function public.kurviq_put_elements(scene uuid, elements json) returns bigint
language plpgsql set search_path = '' as $$
begin
  insert into public.kurviq_elements as e (scene_id, id, version, version_nonce, pos, data)
    select scene, item ->> 'id', (item ->> 'version')::integer, coalesce((item ->> 'versionNonce')::bigint, 0),
      coalesce((item ->> 'kurviqPos')::double precision, 0), (item::jsonb - 'kurviqPos')::json
    from json_array_elements(elements) item
  on conflict (scene_id, id) do update set version = excluded.version, version_nonce = excluded.version_nonce,
    pos = case when excluded.pos = 0 then e.pos else excluded.pos end, data = excluded.data;
  return (select s.revision from public.kurviq_scenes s where s.id = scene);
end $$;

-- comments changed in the editor (the commenter rules and "newer wins" apply); the scene's revision
create or replace function public.kurviq_put_comments(scene uuid, comments jsonb) returns bigint
language plpgsql set search_path = '' as $$
begin
  insert into public.kurviq_comments (scene_id, id, data)
    select scene, item ->> 'id', item from jsonb_array_elements(comments) item
  on conflict (scene_id, id) do update set data = excluded.data;
  return (select s.revision from public.kurviq_scenes s where s.id = scene);
end $$;

-- the scene's settings and pictures' index (pictures are added, never dropped here); the scene's revision
create or replace function public.kurviq_put_meta(scene uuid, envelope json, files jsonb) returns bigint
language plpgsql set search_path = '' as $$
begin
  insert into public.kurviq_scene_meta as m (scene_id, envelope, files) values (scene, coalesce(envelope, '{}'::json), coalesce(files, '{}'::jsonb))
  on conflict (scene_id) do update set envelope = coalesce(envelope, m.envelope), files = m.files || excluded.files;
  return (select s.revision from public.kurviq_scenes s where s.id = scene);
end $$;

-- a whole scene (moved here, restored, an agent's save): only on the revision
-- it is based on (base; null: any), elements it doesn't list are deleted.
-- Returns the new revision; a changed scene: error P0409 with the revision.
create or replace function public.kurviq_save_scene(scene uuid, base bigint, elements json, envelope json, files jsonb, comments jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  current_revision bigint;
begin
  select s.revision into current_revision from public.kurviq_scenes s
    where s.id = scene and s.deleted_at is null and s.moved_to is null for update;
  if current_revision is null then
    raise exception 'Scene not found' using errcode = 'P0002';
  end if;
  if base is not null and base <> current_revision then
    raise exception 'The scene was changed meanwhile' using errcode = 'P0409', detail = current_revision::text;
  end if;
  perform set_config('kurviq.whole_save', 'on', true);
  update public.kurviq_elements e set version = e.version + 1, data = jsonb_set(jsonb_set(e.data::jsonb, '{isDeleted}', 'true'), '{version}', to_jsonb(e.version + 1))::json
    where e.scene_id = scene and coalesce((e.data ->> 'isDeleted')::boolean, false) = false
      and e.id not in (select item ->> 'id' from json_array_elements(elements) item);
  insert into public.kurviq_elements as e (scene_id, id, version, version_nonce, pos, data)
    select scene, item ->> 'id', coalesce((item ->> 'version')::integer, 1), coalesce((item ->> 'versionNonce')::bigint, 0), ord, item
    from json_array_elements(elements) with ordinality as t(item, ord)
  on conflict (scene_id, id) do update set version = excluded.version, version_nonce = excluded.version_nonce, pos = excluded.pos, data = excluded.data;
  insert into public.kurviq_scene_meta (scene_id, envelope, files) values (scene, envelope, coalesce(files, '{}'::jsonb))
  on conflict (scene_id) do update set envelope = excluded.envelope, files = excluded.files;
  if comments is not null and jsonb_array_length(comments) > 0 then
    insert into public.kurviq_comments (scene_id, id, data)
      select scene, item ->> 'id', item from jsonb_array_elements(comments) item
    on conflict (scene_id, id) do update set data = excluded.data;
  end if;
  perform set_config('kurviq.whole_save', 'off', true);
  return (select s.revision from public.kurviq_scenes s where s.id = scene);
end $$;

-- ---------------------------------------------------------------------------
-- row-level security
-- ---------------------------------------------------------------------------

alter table public.kurviq_space enable row level security;
alter table public.kurviq_members enable row level security;
alter table public.kurviq_scenes enable row level security;
alter table public.kurviq_scene_access enable row level security;
alter table public.kurviq_elements enable row level security;
alter table public.kurviq_scene_meta enable row level security;
alter table public.kurviq_comments enable row level security;
alter table public.kurviq_versions enable row level security;

drop policy if exists "kurviq: space read" on public.kurviq_space;
create policy "kurviq: space read" on public.kurviq_space for select to authenticated
  using (public.kurviq_space_role() is not null
    or exists (select 1 from public.kurviq_scene_access a where a.email = public.kurviq_email()));
drop policy if exists "kurviq: space change" on public.kurviq_space;
create policy "kurviq: space change" on public.kurviq_space for update to authenticated
  using (public.kurviq_space_role() = 'owner') with check (public.kurviq_space_role() = 'owner');

drop policy if exists "kurviq: members read" on public.kurviq_members;
create policy "kurviq: members read" on public.kurviq_members for select to authenticated
  using (public.kurviq_space_role() is not null or email = public.kurviq_email());
drop policy if exists "kurviq: members change" on public.kurviq_members;
create policy "kurviq: members change" on public.kurviq_members for all to authenticated
  using (public.kurviq_space_role() = 'owner') with check (public.kurviq_space_role() = 'owner');

drop policy if exists "kurviq: scenes read" on public.kurviq_scenes;
create policy "kurviq: scenes read" on public.kurviq_scenes for select to anon, authenticated
  using (public.kurviq_can_read(id));
drop policy if exists "kurviq: scenes add" on public.kurviq_scenes;
create policy "kurviq: scenes add" on public.kurviq_scenes for insert to authenticated
  with check (public.kurviq_rank(public.kurviq_space_role()) >= 3);
drop policy if exists "kurviq: scenes change" on public.kurviq_scenes;
create policy "kurviq: scenes change" on public.kurviq_scenes for update to authenticated
  using (public.kurviq_rank(public.kurviq_scene_role(id)) >= 3) with check (public.kurviq_rank(public.kurviq_scene_role(id)) >= 3);
drop policy if exists "kurviq: scenes delete" on public.kurviq_scenes;
create policy "kurviq: scenes delete" on public.kurviq_scenes for delete to authenticated
  using (public.kurviq_rank(public.kurviq_scene_role(id)) >= 3);

drop policy if exists "kurviq: access read" on public.kurviq_scene_access;
create policy "kurviq: access read" on public.kurviq_scene_access for select to authenticated
  using (email = public.kurviq_email() or public.kurviq_rank(public.kurviq_scene_role(scene_id)) >= 3);
drop policy if exists "kurviq: access change" on public.kurviq_scene_access;
create policy "kurviq: access change" on public.kurviq_scene_access for all to authenticated
  using (public.kurviq_rank(public.kurviq_scene_role(scene_id)) >= 3) with check (public.kurviq_rank(public.kurviq_scene_role(scene_id)) >= 3);

drop policy if exists "kurviq: elements read" on public.kurviq_elements;
create policy "kurviq: elements read" on public.kurviq_elements for select to anon, authenticated
  using (public.kurviq_can_read(scene_id));
drop policy if exists "kurviq: elements add" on public.kurviq_elements;
create policy "kurviq: elements add" on public.kurviq_elements for insert to authenticated
  with check (public.kurviq_can_edit(scene_id));
drop policy if exists "kurviq: elements change" on public.kurviq_elements;
create policy "kurviq: elements change" on public.kurviq_elements for update to authenticated
  using (public.kurviq_can_edit(scene_id)) with check (public.kurviq_can_edit(scene_id));

drop policy if exists "kurviq: meta read" on public.kurviq_scene_meta;
create policy "kurviq: meta read" on public.kurviq_scene_meta for select to anon, authenticated
  using (public.kurviq_can_read(scene_id));
drop policy if exists "kurviq: meta add" on public.kurviq_scene_meta;
create policy "kurviq: meta add" on public.kurviq_scene_meta for insert to authenticated
  with check (public.kurviq_can_edit(scene_id));
drop policy if exists "kurviq: meta change" on public.kurviq_scene_meta;
create policy "kurviq: meta change" on public.kurviq_scene_meta for update to authenticated
  using (public.kurviq_can_edit(scene_id)) with check (public.kurviq_can_edit(scene_id));

-- comments: members only (not on public scenes for people without access)
drop policy if exists "kurviq: comments read" on public.kurviq_comments;
create policy "kurviq: comments read" on public.kurviq_comments for select to authenticated
  using (public.kurviq_scene_role(scene_id) is not null);
drop policy if exists "kurviq: comments add" on public.kurviq_comments;
create policy "kurviq: comments add" on public.kurviq_comments for insert to authenticated
  with check (public.kurviq_can_comment(scene_id));
drop policy if exists "kurviq: comments change" on public.kurviq_comments;
create policy "kurviq: comments change" on public.kurviq_comments for update to authenticated
  using (public.kurviq_can_comment(scene_id)) with check (public.kurviq_can_comment(scene_id));

drop policy if exists "kurviq: versions read" on public.kurviq_versions;
create policy "kurviq: versions read" on public.kurviq_versions for select to authenticated
  using (public.kurviq_scene_role(scene_id) is not null);
drop policy if exists "kurviq: versions add" on public.kurviq_versions;
create policy "kurviq: versions add" on public.kurviq_versions for insert to authenticated
  with check (public.kurviq_can_edit(scene_id));

grant select on public.kurviq_scenes, public.kurviq_elements, public.kurviq_scene_meta to anon;
grant select, insert, update, delete on public.kurviq_space, public.kurviq_members, public.kurviq_scenes,
  public.kurviq_scene_access, public.kurviq_elements, public.kurviq_scene_meta, public.kurviq_comments,
  public.kurviq_versions to authenticated;
grant execute on function public.kurviq_schema_version(), public.kurviq_scene_role(uuid), public.kurviq_space_role(),
  public.kurviq_can_read(uuid) to anon, authenticated;
grant execute on function public.kurviq_claim_space(text), public.kurviq_put_elements(uuid, json),
  public.kurviq_put_comments(uuid, jsonb), public.kurviq_put_meta(uuid, json, jsonb),
  public.kurviq_save_scene(uuid, bigint, json, json, jsonb, jsonb) to authenticated;
revoke execute on function public.kurviq_claim_space(text), public.kurviq_put_elements(uuid, json),
  public.kurviq_put_comments(uuid, jsonb), public.kurviq_put_meta(uuid, json, jsonb),
  public.kurviq_save_scene(uuid, bigint, json, json, jsonb, jsonb) from anon;

-- ---------------------------------------------------------------------------
-- pictures: storage bucket "kurviq-files", one object per picture at
-- <scene id>/<file id>, readable like the scene, written by its editors
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public) values ('kurviq-files', 'kurviq-files', false)
  on conflict (id) do nothing;

drop policy if exists "kurviq: files read" on storage.objects;
create policy "kurviq: files read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'kurviq-files' and public.kurviq_can_read(public.kurviq_uuid((storage.foldername(name))[1])));
drop policy if exists "kurviq: files add" on storage.objects;
create policy "kurviq: files add" on storage.objects for insert to authenticated
  with check (bucket_id = 'kurviq-files' and public.kurviq_can_edit(public.kurviq_uuid((storage.foldername(name))[1])));
drop policy if exists "kurviq: files change" on storage.objects;
create policy "kurviq: files change" on storage.objects for update to authenticated
  using (bucket_id = 'kurviq-files' and public.kurviq_can_edit(public.kurviq_uuid((storage.foldername(name))[1])));
drop policy if exists "kurviq: files delete" on storage.objects;
create policy "kurviq: files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'kurviq-files' and public.kurviq_rank(public.kurviq_scene_role(public.kurviq_uuid((storage.foldername(name))[1]))) >= 3);

-- ---------------------------------------------------------------------------
-- realtime: each scene's private channel "kurviq:<scene id>". Everyone who
-- may read the scene listens and shares presence (name, color, pointer);
-- editors also broadcast their changes there before the database has them.
-- ---------------------------------------------------------------------------

drop policy if exists "kurviq: channel listen" on realtime.messages;
create policy "kurviq: channel listen" on realtime.messages for select to anon, authenticated
  using (realtime.topic() like 'kurviq:%' and public.kurviq_can_read(public.kurviq_uuid(substr(realtime.topic(), 8))));
drop policy if exists "kurviq: channel send" on realtime.messages;
create policy "kurviq: channel send" on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'kurviq:%' and (
    (realtime.messages.extension = 'presence' and public.kurviq_scene_role(public.kurviq_uuid(substr(realtime.topic(), 8))) is not null)
    or (realtime.messages.extension = 'broadcast' and public.kurviq_can_edit(public.kurviq_uuid(substr(realtime.topic(), 8))))));
