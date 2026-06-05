import { getAdminClient } from './supabase-admin';

// Server-side account initialisation after a new user signs up. Lives in
// src/admin/ because it uses the privileged client (creating an accounts
// row + the owner membership; account_members has no public INSERT policy).
//
// User-facing routes import THIS function, never the admin client itself.
// That's the boundary the ESLint rule enforces.

export interface CreatedAccount {
  accountId: string;
}

export async function createAccountForNewUser(
  userId: string,
  email: string,
  accountName: string,
): Promise<CreatedAccount> {
  const admin = getAdminClient();

  // Profile mirror. users.id FKs to auth.users.id; the row may already exist
  // if signup is retried after a partial failure, so we upsert.
  const { error: userErr } = await admin
    .from('users')
    .upsert({ id: userId, display_name: email }, { onConflict: 'id' });
  if (userErr) {
    throw new Error(`failed to upsert public.users row: ${userErr.message}`);
  }

  const { data: account, error: accErr } = await admin
    .from('accounts')
    .insert({ name: accountName })
    .select('id')
    .single();
  if (accErr || !account) {
    throw new Error(`failed to create account: ${accErr?.message ?? 'no row returned'}`);
  }

  const { error: memErr } = await admin
    .from('account_members')
    .insert({ account_id: account.id, user_id: userId, role: 'owner' });
  if (memErr) {
    throw new Error(`failed to create owner membership: ${memErr.message}`);
  }

  return { accountId: account.id };
}
