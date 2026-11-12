-- Report-only (WP-15): money rows and setup drafts whose currency is not an ISO 4217 code.
-- Nothing is changed; set each to the account currency only after reviewing it.
-- psql -f db/scripts/report-non-iso-currencies.sql
\set ON_ERROR_STOP on
with iso(code) as (select unnest(array['AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL','BSD','BTN','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY','COP','CRC','CUC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HRK','HTG','HUF','IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR','KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SLL','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX','USD','UYU','UZS','VES','VND','VUV','WST','XAF','XCD','XCG','XDR','XOF','XPF','XSU','YER','ZAR','ZMW','ZWG','ZWL']))
select 'lease rent' as source, account_id, id, rent_currency as currency from public.leases
  where deleted_at is null and rent_currency not in (select code from iso)
union all select 'lease deposit', account_id, id, deposit_currency from public.leases
  where deleted_at is null and deposit_amount_cents > 0 and deposit_currency not in (select code from iso)
union all select 'rent schedule', account_id, id, currency from public.rent_schedules
  where deleted_at is null and currency not in (select code from iso)
union all select 'charge', account_id, id, currency from public.charges
  where deleted_at is null and currency not in (select code from iso)
union all select 'payment', account_id, id, currency from public.payments
  where deleted_at is null and currency not in (select code from iso)
union all select 'setup draft', s.account_id, s.id, c2.value from public.tenancy_setup_sessions s,
  lateral jsonb_path_query(s.payload, 'strict $.**.currency') c(value_json),
  lateral (select c.value_json #>> '{}' as value) c2(value)
  where s.completed_at is null and s.expires_at > now() and jsonb_typeof(c.value_json) = 'string'
    and c2.value not in (select code from iso)
order by 1, 2, 3;
