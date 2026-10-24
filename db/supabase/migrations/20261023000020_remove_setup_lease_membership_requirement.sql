begin;

do $$
declare
  body text;
  old text;
begin
  select pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure) into body;
  old:=E'\n    if (person->>''on_lease'')::boolean is null then raise exception ''invalid: confirm whether each person is on the lease'';end if;';
  assert position(old in body)>0,'setup membership validation changed';
  execute replace(body,old,'');

  select pg_get_functiondef('public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text)'::regprocedure) into body;
  old:='insert into public.tenancy_tenants(account_id,tenancy_id,tenant_id,role,on_lease)';
  assert position(old in body)>0,'setup membership insert changed';
  body:=replace(body,old,'insert into public.tenancy_tenants(account_id,tenancy_id,tenant_id,role)');
  old:='end,(person->>''on_lease'')::boolean);';
  assert position(old in body)>0,'setup membership insert values changed';
  body:=replace(body,old,'end);');
  old:=E'    else\n      update public.tenancy_tenants set on_lease=(person->>''on_lease'')::boolean,updated_at=clock_timestamp() where account_id=p_account_id and id=member_id;\n    end if;';
  assert position(old in body)>0,'setup membership write changed';
  body:=replace(body,old,'    end if;');
  old:='jsonb_build_object(''tenant_id'',person_id,''on_lease'',person->''on_lease'')';
  assert position(old in body)>0,'setup party snapshot changed';
  execute replace(body,old,'jsonb_build_object(''tenant_id'',person_id)');
end $$;

alter table public.tenancy_tenants drop column on_lease;

notify pgrst,'reload schema';
commit;
