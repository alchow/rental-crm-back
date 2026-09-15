do $$
declare definition text;
begin
  select pg_get_functiondef('public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text)'::regprocedure) into definition;
  if strpos(definition,'from publiwaived.charges c')=0 then raise exception 'waiver relation not found'; end if;
  execute replace(definition,'from publiwaived.charges c','from public.charges waived');
end $$;
