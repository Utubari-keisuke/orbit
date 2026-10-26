-- Orbit schema. Supabase の SQL Editor に丸ごと貼って実行します。
-- 方針: 自分の星は自分だけが読み書きできる。公開中のユーザーの星だけ、他者が「関数経由で」少数取得できる。

create extension if not exists pgcrypto;

-- ---------- profiles ----------
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  handle      text not null unique,
  is_public   boolean not null default true,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- ---------- stars ----------
create table if not exists public.stars (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  word        text not null check (char_length(word) between 1 and 24),
  kind        text not null check (kind in ('star','planet','satellite','meteor','blackhole','wormhole')),
  hue         real not null,
  e           real not null check (e >= 0 and e < 1),
  incl        real not null,
  node        real not null,
  a           real not null check (a > 0 and a < 40),
  intensity   real not null check (intensity between 0 and 1),
  is_binary   boolean not null default false,
  parent_id   uuid references public.stars(id) on delete cascade,
  link_id     uuid references public.stars(id) on delete set null,
  history     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists stars_user_idx on public.stars(user_id, created_at);

-- ---------- crossings (自分から見た交差・回避のログ) ----------
create table if not exists public.crossings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  other_handle  text not null,
  other_hue     real not null,
  action        text not null check (action in ('cross','avoid','timeout')),
  result        text check (result in ('resonance','interference','fusion')),
  star_word     text,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists crossings_user_idx on public.crossings(user_id, created_at desc);

-- ---------- reports (通報) ----------
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid not null references auth.users(id) on delete cascade,
  other_handle  text not null,
  reason        text not null check (char_length(reason) <= 400),
  created_at    timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.profiles  enable row level security;
alter table public.stars     enable row level security;
alter table public.crossings enable row level security;
alter table public.reports   enable row level security;

drop policy if exists profiles_own_all on public.profiles;
create policy profiles_own_all on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists stars_own_all on public.stars;
create policy stars_own_all on public.stars
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists crossings_own_all on public.crossings;
create policy crossings_own_all on public.crossings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
  for insert with check (auth.uid() = reporter_id);

-- ---------- 関数 ----------

-- 初回ログイン時に、匿名のハンドル(Orbit #1234)付きでプロフィールを作る。
create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles;
  h text;
  tries int := 0;
begin
  select * into p from public.profiles where user_id = auth.uid();
  if found then
    update public.profiles set last_seen = now() where user_id = auth.uid() returning * into p;
    return p;
  end if;
  loop
    h := '#' || lpad((floor(random() * 10000))::int::text, 4, '0');
    begin
      insert into public.profiles(user_id, handle) values (auth.uid(), h) returning * into p;
      return p;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 30 then raise exception 'handle space exhausted'; end if;
    end;
  end loop;
end;
$$;

-- 他者のOrbitを1件、ランダムに返す。
-- 返すのは「ハンドル・星の言葉・かたち」だけ。user_id やメールは返さない。
-- 条件: 公開中 / 自分ではない / 星が1つ以上 / 自分が通報した相手は除外 / 直近30日以内にログイン
create or replace function public.random_orbit(exclude_handles text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.profiles;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select p.* into target
  from public.profiles p
  where p.user_id <> auth.uid()
    and p.is_public
    and p.last_seen > now() - interval '30 days'
    and not (p.handle = any(exclude_handles))
    and not exists (select 1 from public.reports r where r.reporter_id = auth.uid() and r.other_handle = p.handle)
    and exists (select 1 from public.stars s where s.user_id = p.user_id)
  order by random()
  limit 1;

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'handle', target.handle,
    'stars', coalesce(jsonb_agg(jsonb_build_object('word', t.word, 'hue', t.hue) order by t.created_at desc), '[]'::jsonb)
  ) into result
  from (
    select s.word, s.hue, s.created_at
    from public.stars s
    where s.user_id = target.user_id and s.kind <> 'blackhole'   -- 重い感情・沈黙は共有しない
    order by s.created_at desc
    limit 4
  ) t;

  return result;
end;
$$;

-- 自分の全データを消す(アカウント削除前の「すべて消す」用)。
create or replace function public.wipe_my_data()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.stars     where user_id = auth.uid();
  delete from public.crossings where user_id = auth.uid();
$$;

revoke all on function public.ensure_profile()      from public;
revoke all on function public.random_orbit(text[])  from public;
revoke all on function public.wipe_my_data()        from public;
grant execute on function public.ensure_profile()      to authenticated;
grant execute on function public.random_orbit(text[])  to authenticated;
grant execute on function public.wipe_my_data()        to authenticated;
