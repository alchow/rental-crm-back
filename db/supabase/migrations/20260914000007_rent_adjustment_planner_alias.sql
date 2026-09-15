-- Avoid colliding with the planner's `c public.charges` record variable.
do $$
declare
  definition text;
  corrected text;
begin
  select pg_get_functiondef('public._plan_rent_adjustment(uuid,uuid,jsonb)'::regprocedure)
    into definition;
  corrected := replace(
    definition,
    'union select c.id from public.charges c join derived d on c.parent_charge_id=d.id
      where c.account_id=p_account_id and c.voided_at is null and c.deleted_at is null',
    'union select child.id from public.charges child join derived d on child.parent_charge_id=d.id
      where child.account_id=p_account_id and child.voided_at is null and child.deleted_at is null'
  );
  if corrected = definition then
    raise exception '_plan_rent_adjustment recursive charge query was not found';
  end if;
  execute corrected;
end;
$$;
