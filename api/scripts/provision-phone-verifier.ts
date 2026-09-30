import { z } from 'zod';
import { provisionPhoneVerifierKey } from '../src/admin/owner-phone-verifier';

const input = z
  .object({
    keyId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    verifierId: z.string().uuid(),
    secret: z.string().min(32).max(256),
  })
  .safeParse({
    keyId: process.argv[2],
    verifierId: process.argv[3],
    secret: process.env.PHONE_VERIFIER_SECRET,
  });
if (!input.success) {
  console.error(
    'Usage: PHONE_VERIFIER_SECRET=<secret> tsx scripts/provision-phone-verifier.ts <key-id> <logical-verifier-uuid>',
  );
  process.exitCode = 1;
} else {
  await provisionPhoneVerifierKey(input.data);
  console.info(`Provisioned phone verifier key ${input.data.keyId}; plaintext was not stored.`);
}
