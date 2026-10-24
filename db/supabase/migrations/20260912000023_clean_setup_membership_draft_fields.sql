begin;

update public.tenancy_setup_sessions d
set payload=jsonb_set(d.payload,'{people}',(
      select jsonb_agg(person.value-'on_lease' order by person.ordinality)
      from jsonb_array_elements(d.payload->'people') with ordinality person
    )),
    revision=d.revision+1,
    updated_at=clock_timestamp()
where d.completed_at is null
  and jsonb_typeof(d.payload->'people')='array'
  and exists (
    select 1 from jsonb_array_elements(d.payload->'people') person where person?'on_lease'
  );

commit;
