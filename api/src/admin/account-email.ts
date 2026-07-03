import { getAdminClient } from './supabase-admin';
import { loadEnv } from '../env';
import { getLogger } from '../log';
import { composeFromAddress } from '../routes/_lib/email-slug';

// Send-time resolution of an account's From identity ("Name <slug@domain>").
//
// Lives in admin/ because the callers are service-tier flows (e.g. the
// inspection-capture renewal email) that run outside any user JWT -- the read
// goes through the admin client. Composition is shared with the
// account-email route via routes/_lib/email-slug.ts, so the address a
// landlord previews on PUT /email-identity is byte-identical to the one the
// mailer puts on the wire.
//
// Best-effort by design: identity resolution must never turn a deliverable
// email into a failure. Any miss (env unset, no slug, read error) returns
// null and the caller falls back to the global MAIL_FROM.

export async function accountFromAddress(accountId: string): Promise<string | null> {
  const domain = loadEnv().ACCOUNT_EMAIL_DOMAIN;
  if (!domain) return null;
  try {
    const { data, error } = await getAdminClient()
      .from('accounts')
      .select('name, email_slug')
      .eq('id', accountId)
      .maybeSingle();
    if (error) {
      getLogger().warn(
        `[account-email] identity read failed for account=${accountId}: ${error.message}; falling back to MAIL_FROM`,
      );
      return null;
    }
    return composeFromAddress(
      (data?.name as string | null) ?? null,
      (data?.email_slug as string | null) ?? null,
      domain,
    );
  } catch (cause) {
    getLogger().warn(
      `[account-email] identity read threw for account=${accountId}: ${String(cause)}; falling back to MAIL_FROM`,
    );
    return null;
  }
}
