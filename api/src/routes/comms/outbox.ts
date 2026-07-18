import { registerOutboxCreateRoute } from './outbox/create';
import { registerOutboxLifecycleRoutes } from './outbox/lifecycle';
import type { CommsApp } from './shared';

/** Stable route-group facade; implementation lives in focused modules. */
export function registerOutboxRoutes(app: CommsApp): void {
  registerOutboxCreateRoute(app);
  registerOutboxLifecycleRoutes(app);
}
