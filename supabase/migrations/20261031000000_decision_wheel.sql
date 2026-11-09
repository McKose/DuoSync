-- =============================================================================
-- DuoSync — decision wheel "Ne yesek?" (ROADMAP C1)
--
-- The result is drawn inside spin_wheel() (SECURITY DEFINER, CSPRNG via
-- gen_random_uuid) and stored together with the option list it was drawn
-- from, so neither partner can pick or rewrite it and both phones animate the
-- same wheel to the same segment. Clients only SELECT; every write is an RPC.
-- =============================================================================

create table public.wheel_options (
    id         uuid primary key default gen_random_uuid(),
    couple_id  uuid not null references public.couples (id) on delete cascade,
    created_by uuid references public.profiles (id) on delete set null,
    label      text not null check (char_length(label) between 1 and 30 and label = btrim(label)),
    created_at timestamptz not null default now()
);
create unique index wheel_options_couple_label on public.wheel_options (couple_id, lower(label));

create table public.wheel_spins (
    id            uuid primary key default gen_random_uuid(),
    couple_id     uuid not null references public.couples (id) on delete cascade,
    spun_by       uuid references public.profiles (id) on delete set null,
    -- Snapshot of the wheel at spin time (option order = segment order).
    option_labels jsonb not null check (jsonb_typeof(option_labels) = 'array'
                                        and jsonb_array_length(option_labels) between 2 and 12),
    result_index  smallint not null,
    result_label  text not null,
    created_at    timestamptz not null default now(),
    constraint wheel_spins_result_matches
        check (result_index >= 0 and option_labels ->> result_index::int = result_label)
);
create index wheel_spins_couple_created on public.wheel_spins (couple_id, created_at desc);

alter table public.wheel_options enable row level security;
alter table public.wheel_spins   enable row level security;

create policy "wheel_options_select_member" on public.wheel_options
    for select to authenticated
    using (public.is_couple_member(couple_id));
create policy "wheel_spins_select_member" on public.wheel_spins
    for select to authenticated
    using (public.is_couple_member(couple_id));

revoke all on public.wheel_options, public.wheel_spins from anon, authenticated;
grant select on public.wheel_options, public.wheel_spins to authenticated;

-- -----------------------------------------------------------------------------
-- RPCs. Each locks the couple row first, so the option cap, duplicate check
-- and spin cooldown are race-free between the two phones.
-- -----------------------------------------------------------------------------
create or replace function public.add_wheel_option(p_label text)
returns public.wheel_options
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_couple public.couples := public.my_active_couple();
    v_label text := btrim(coalesce(p_label, ''));
    v_row public.wheel_options;
begin
    if v_couple.id is null then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;
    if char_length(v_label) not between 1 and 30 then
        raise exception 'INVALID_OPTION_LABEL' using errcode = 'P0001';
    end if;
    perform 1 from public.couples c where c.id = v_couple.id for update;

    if exists (select 1 from public.wheel_options o
               where o.couple_id = v_couple.id and lower(o.label) = lower(v_label)) then
        raise exception 'DUPLICATE_OPTION' using errcode = 'P0001';
    end if;
    if (select count(*) from public.wheel_options o where o.couple_id = v_couple.id) >= 12 then
        raise exception 'WHEEL_FULL' using errcode = 'P0001';
    end if;

    insert into public.wheel_options (couple_id, created_by, label)
    values (v_couple.id, auth.uid(), v_label)
    returning * into v_row;
    return v_row;
end;
$$;

create or replace function public.remove_wheel_option(p_option_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_couple public.couples := public.my_active_couple();
begin
    delete from public.wheel_options o
    where o.id = p_option_id and o.couple_id = v_couple.id;
    if not found then
        raise exception 'OPTION_NOT_FOUND' using errcode = 'P0001';
    end if;
end;
$$;

create or replace function public.spin_wheel()
returns public.wheel_spins
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_couple public.couples := public.my_active_couple();
    v_labels jsonb;
    v_index int;
    v_row public.wheel_spins;
begin
    if v_couple.id is null then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;
    perform 1 from public.couples c where c.id = v_couple.id for update;

    -- Longer than the client animation, so a spin always finishes on both
    -- phones before the next one can start (and re-spin spam stays visible).
    if exists (select 1 from public.wheel_spins s
               where s.couple_id = v_couple.id and s.created_at > now() - interval '10 seconds') then
        raise exception 'SPIN_COOLDOWN' using errcode = 'P0001';
    end if;

    select coalesce(jsonb_agg(o.label order by o.created_at, o.id), '[]'::jsonb) into v_labels
    from public.wheel_options o where o.couple_id = v_couple.id;
    if jsonb_array_length(v_labels) < 2 then
        raise exception 'NOT_ENOUGH_OPTIONS' using errcode = 'P0001';
    end if;

    -- Uniform pick; gen_random_uuid() draws from the server's strong RNG.
    select (t.ord - 1)::int into v_index
    from jsonb_array_elements_text(v_labels) with ordinality as t(label, ord)
    order by gen_random_uuid()
    limit 1;

    insert into public.wheel_spins (couple_id, spun_by, option_labels, result_index, result_label)
    values (v_couple.id, auth.uid(), v_labels, v_index, v_labels ->> v_index)
    returning * into v_row;

    -- History: keep the 20 most recent spins per couple.
    delete from public.wheel_spins s
    where s.couple_id = v_couple.id
      and s.id not in (select s2.id from public.wheel_spins s2
                       where s2.couple_id = v_couple.id
                       order by s2.created_at desc, s2.id
                       limit 20);
    return v_row;
end;
$$;

revoke execute on function public.add_wheel_option(text), public.remove_wheel_option(uuid), public.spin_wheel()
    from public, anon, authenticated;
grant execute on function public.add_wheel_option(text)    to authenticated;
grant execute on function public.remove_wheel_option(uuid) to authenticated;
grant execute on function public.spin_wheel()              to authenticated;

alter publication supabase_realtime add table public.wheel_options, public.wheel_spins;
