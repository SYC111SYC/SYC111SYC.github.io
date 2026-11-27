create table if not exists public.catball_profiles (
  email text primary key,
  pet_name text not null default '猫球' check (char_length(pet_name) <= 16),
  food bigint not null default 0 check (food >= 0),
  points bigint not null default 0 check (points >= 0),
  inventory jsonb not null default '{}'::jsonb check (jsonb_typeof(inventory) = 'object'),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.catball_redemptions (
  code text primary key,
  points integer not null check (points > 0),
  email text,
  request_id text unique,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  check ((email is null and request_id is null and redeemed_at is null) or
    (email is not null and request_id is not null and redeemed_at is not null))
);

create index if not exists catball_redemptions_email_idx on public.catball_redemptions (email);

alter table public.catball_profiles enable row level security;
alter table public.catball_redemptions enable row level security;

-- 不添加 anon/authenticated 策略：前端只能经 Edge Function 使用 service role 访问。
-- 管理员预置礼品码：insert into public.catball_redemptions(code, points) values ('DQXXXXXXXX', 20);

create or replace function public.catball_redeem(
  p_email text,
  p_code text,
  p_request_id text
) returns table (
  ok boolean,
  msg text,
  state jsonb,
  revision bigint,
  awarded integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.catball_redemptions%rowtype;
  v_profile public.catball_profiles%rowtype;
begin
  select * into v_code from public.catball_redemptions as redemption
    where redemption.code = p_code for update;

  if not found then
    return query select false, '礼品码不存在或已失效', null::jsonb, 0::bigint, 0;
    return;
  end if;

  if v_code.email is not null then
    if v_code.email = p_email and v_code.request_id = p_request_id then
      select * into v_profile from public.catball_profiles as profile where profile.email = p_email;
      return query select true, '该兑换请求已处理，积分已到账',
        jsonb_build_object('petName', v_profile.pet_name, 'food', v_profile.food,
          'points', v_profile.points, 'inventory', v_profile.inventory),
        v_profile.revision, 0;
    else
      return query select false, '礼品码已被兑换', null::jsonb, 0::bigint, 0;
    end if;
    return;
  end if;

  select * into v_profile from public.catball_profiles as profile
    where profile.email = p_email for update;
  if not found then
    return query select false, '云端存档尚未建立，请重新打开页面后再试', null::jsonb, 0::bigint, 0;
    return;
  end if;

  update public.catball_redemptions as redemption
    set email = p_email, request_id = p_request_id, redeemed_at = now()
    where redemption.code = p_code;

  update public.catball_profiles as profile
    set points = profile.points + v_code.points,
        revision = profile.revision + 1,
        updated_at = now()
    where profile.email = p_email
    returning * into v_profile;

  return query select true, '兑换成功，积分已到账',
    jsonb_build_object('petName', v_profile.pet_name, 'food', v_profile.food,
      'points', v_profile.points, 'inventory', v_profile.inventory),
    v_profile.revision, v_code.points;
end;
$$;

revoke all on function public.catball_redeem(text, text, text) from public, anon, authenticated;
grant execute on function public.catball_redeem(text, text, text) to service_role;
