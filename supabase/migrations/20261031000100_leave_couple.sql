-- =============================================================================
-- DuoSync — leave couple / unpair (ROADMAP B2)
--
-- Decision 2026-10-31: on unpair all shared data is deleted. Deleting the
-- couple cascades to court_cases, plans, delayed_messages, pending_questions,
-- wheel_options and wheel_spins. Profiles, push tokens and pairing attempts
-- are personal and stay, so both users can pair again right away.
--
-- Cooling-off: unsent (PENDING/CANCELLED) messages are deleted with the rest.
-- The delayed_messages trigger fires on UPDATE only, so no release push is
-- queued for them; the partner's notification below carries no detail about
-- what was deleted.
-- =============================================================================

create or replace function public.leave_couple()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_couple public.couples := public.my_active_couple();
    v_partner uuid;
begin
    if v_couple.id is null then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;
    -- Both partners may tap at the same moment: the second waits for the
    -- lock, then finds the row gone.
    select * into v_couple from public.couples c where c.id = v_couple.id and c.is_active for update;
    if not found then
        raise exception 'NOT_PAIRED' using errcode = 'P0001';
    end if;
    v_partner := case when v_couple.user_a_id = auth.uid() then v_couple.user_b_id else v_couple.user_a_id end;

    delete from public.couples c where c.id = v_couple.id;

    -- pg_net sends after commit, so a rolled-back leave never notifies.
    perform private.push(
        v_partner, 'COUPLE_ENDED', 'Eşleşme sona erdi',
        'Partnerin eşleşmeyi sonlandırdı; ortak verileriniz silindi.', '{}'::jsonb
    );
end;
$$;

revoke execute on function public.leave_couple() from public, anon, authenticated;
grant execute on function public.leave_couple() to authenticated;
