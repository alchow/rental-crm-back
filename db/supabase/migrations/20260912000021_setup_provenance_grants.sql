begin;

revoke insert on public.tenancy_setup_confirmations from authenticated;
grant insert(account_id,setup_session_id,tenancy_id,lease_id,setup_snapshot,review_snapshot,entered_by)
  on public.tenancy_setup_confirmations to authenticated;

create function public._freeze_payment_receipt_provenance() returns trigger
language plpgsql set search_path=public as $$
begin
  if (NEW.receipt_date_unknown,NEW.entry_source) is distinct from (OLD.receipt_date_unknown,OLD.entry_source)
    or (OLD.entry_source='entered_at_setup' and NEW.received_at is distinct from OLD.received_at) then
    raise exception 'receipt provenance is immutable; void and re-record the payment' using errcode='23514';
  end if;
  return NEW;
end $$;
revoke all on function public._freeze_payment_receipt_provenance() from public,anon,authenticated;
create trigger payments_receipt_provenance before update on public.payments
  for each row execute function public._freeze_payment_receipt_provenance();

notify pgrst,'reload schema';
commit;
