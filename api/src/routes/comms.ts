import { newApiApp } from './_lib/app';
import { registerAttachmentRoutes } from './comms/attachments';
import { registerInboundRoutes } from './comms/inbound';
import { registerOutboxRoutes } from './comms/outbox';
import { registerPersonaRoutes } from './comms/persona';
import { registerPolicyRoutes } from './comms/policies';
import { registerThreadRoutes } from './comms/threads';

export const commsApp = newApiApp();

registerOutboxRoutes(commsApp);
registerInboundRoutes(commsApp);
registerPersonaRoutes(commsApp);
registerThreadRoutes(commsApp);
registerAttachmentRoutes(commsApp);
registerPolicyRoutes(commsApp);
