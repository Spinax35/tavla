-- Tavla Nova — Rekabetçi (Sıralı) Mod Supabase Şeması
-- Bu dosya Supabase SQL Editor'de çalıştırılmıştır; buradaki kopya sadece
-- referans ve versiyon takibi içindir.

-- ============ 1) Oyuncu profilleri ============
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Oyuncu',
  rating integer not null default 1000,
  wins integer not null default 0,
  losses integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_all" on public.profiles
  for select using (true);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- NOT: UPDATE policy kasıtlı olarak yok.
-- rating/wins/losses SADECE aşağıdaki güvenli fonksiyonlar üzerinden değişir.

-- ============ 2) Maç raporları (iki taraf da onaylamalı) ============
create table if not exists public.match_reports (
  room_code text not null,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  opponent_id uuid not null references auth.users(id) on delete cascade,
  winner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (room_code, reporter_id)
);

alter table public.match_reports enable row level security;

create policy "match_reports_insert_own" on public.match_reports
  for insert with check (auth.uid() = reporter_id);

create policy "match_reports_update_own" on public.match_reports
  for update using (auth.uid() = reporter_id);

create policy "match_reports_select_related" on public.match_reports
  for select using (auth.uid() = reporter_id or auth.uid() = opponent_id);

-- ============ 3) Maç geçmişi ============
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  winner_id uuid not null references auth.users(id),
  loser_id uuid not null references auth.users(id),
  winner_rating_change integer not null,
  loser_rating_change integer not null,
  created_at timestamptz not null default now()
);

alter table public.matches enable row level security;

create policy "matches_select_all" on public.matches
  for select using (true);

-- ============ 4) Profil oluşturma / güncelleme fonksiyonu ============
create or replace function public.ensure_profile(p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (auth.uid(), coalesce(nullif(trim(p_display_name), ''), 'Oyuncu'))
  on conflict (id) do update set display_name = excluded.display_name;
end;
$$;

grant execute on function public.ensure_profile(text) to authenticated;

-- ============ 5) Maç sonucu bildirme + ELO hesaplama fonksiyonu ============
create or replace function public.report_match_result(
  p_room_code text,
  p_opponent_id uuid,
  p_winner_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_existing record;
  v_winner_rating int;
  v_loser_rating int;
  v_expected numeric;
  v_k int := 32;
  v_change int;
  v_winner_id uuid;
  v_loser_id uuid;
begin
  if v_me is null then
    raise exception 'Giriş yapmalısın';
  end if;

  insert into public.match_reports (room_code, reporter_id, opponent_id, winner_id)
  values (p_room_code, v_me, p_opponent_id, p_winner_id)
  on conflict (room_code, reporter_id)
  do update set winner_id = excluded.winner_id, opponent_id = excluded.opponent_id, created_at = now();

  select * into v_existing
  from public.match_reports
  where room_code = p_room_code and reporter_id = p_opponent_id and opponent_id = v_me;

  if not found then
    return jsonb_build_object('status', 'waiting_for_opponent');
  end if;

  if v_existing.winner_id <> p_winner_id then
    delete from public.match_reports where room_code = p_room_code and reporter_id in (v_me, p_opponent_id);
    return jsonb_build_object('status', 'mismatch');
  end if;

  v_winner_id := p_winner_id;
  v_loser_id := case when p_winner_id = v_me then p_opponent_id else v_me end;

  select rating into v_winner_rating from public.profiles where id = v_winner_id;
  select rating into v_loser_rating from public.profiles where id = v_loser_id;

  v_expected := 1.0 / (1.0 + power(10, (v_loser_rating - v_winner_rating) / 400.0));
  v_change := round(v_k * (1 - v_expected));
  if v_change < 1 then v_change := 1; end if;

  update public.profiles set rating = rating + v_change, wins = wins + 1 where id = v_winner_id;
  update public.profiles set rating = greatest(0, rating - v_change), losses = losses + 1 where id = v_loser_id;

  insert into public.matches (room_code, winner_id, loser_id, winner_rating_change, loser_rating_change)
  values (p_room_code, v_winner_id, v_loser_id, v_change, -v_change);

  delete from public.match_reports where room_code = p_room_code and reporter_id in (v_me, p_opponent_id);

  return jsonb_build_object('status', 'recorded', 'change', v_change);
end;
$$;

grant execute on function public.report_match_result(text, uuid, uuid) to authenticated;

-- ============ 6) Liderlik tablosu için hazır görünüm ============
create or replace view public.leaderboard as
select
  id,
  display_name,
  rating,
  wins,
  losses,
  case
    when rating < 1000 then 'Bronz'
    when rating < 1300 then 'Gümüş'
    when rating < 1600 then 'Altın'
    when rating < 1900 then 'Platin'
    else 'Elmas'
  end as league,
  row_number() over (order by rating desc) as rank
from public.profiles
order by rating desc;

grant select on public.leaderboard to anon, authenticated;
