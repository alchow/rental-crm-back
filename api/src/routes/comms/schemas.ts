// Stable schema facade for route handlers and OpenAPI emission. Domain schema
// modules stay below a useful context boundary while callers keep one import path.
export * from './schema/outbox';
export * from './schema/inbound';
export * from './schema/threads';
export * from './schema/policies';
export * from './schema/common';
export * from './schema/attachments';
export * from './schema/unmatched';
export * from './schema/platform-numbers';
