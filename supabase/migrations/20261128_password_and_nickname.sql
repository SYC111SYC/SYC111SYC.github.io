create table if not exists public.user_passwords (
  email text primary key,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.password_reset (
  email text primary key,
  code text not null check (code ~ '^\d{6}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.catball_profiles
  add column if not exists nickname text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'catball_profiles_nickname_length'
  ) then
    alter table public.catball_profiles
      add constraint catball_profiles_nickname_length check (char_length(nickname) <= 16);
  end if;
end;
$$;

alter table public.user_passwords enable row level security;
alter table public.password_reset enable row level security;

-- 密码哈希、重置码和昵称只能由 Edge Function 使用 service role 访问。
-- 不创建 anon/authenticated 策略。
