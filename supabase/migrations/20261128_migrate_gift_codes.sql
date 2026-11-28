-- 把旧 create-code 写入 gift_codes 的礼品码迁移到兑换函数实际读取的 catball_redemptions
do $$
begin
  if to_regclass('public.gift_codes') is not null then
    insert into public.catball_redemptions (code, points)
    select upper(btrim(code)), points
    from public.gift_codes
    where points > 0
    on conflict (code) do nothing;
  end if;
end;
$$;
