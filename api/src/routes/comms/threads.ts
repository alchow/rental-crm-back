import type { CommsApp } from './shared';
import { registerThreadCreateRoute } from './threads/create';
import { registerThreadReadRoutes } from './threads/read';
import { registerThreadWriteRoutes } from './threads/write';

/** Stable route-group facade; implementation lives in focused modules. */
export function registerThreadRoutes(app: CommsApp): void {
  registerThreadReadRoutes(app);
  registerThreadCreateRoute(app);
  registerThreadWriteRoutes(app);
}
