/**
 * @rookery/server - the HTTP + websocket surface over @rookery/core.
 *
 * Importing this module never starts a listener; `main.ts` does that.
 */

export { buildServer, type BuildServerOptions } from './server.js';
export { publicConfig, VERSION, type ServerContext } from './context.js';
export { bearerToken, createAuthHook, isAuthorized, queryToken } from './auth.js';
export { registerStatic, webDistPath } from './static.js';
export {
  openSse,
  pipeToSse,
  sendFrame,
  type ServerFrame,
  type SseStream,
} from './services/stream.js';
export { TurnHub } from './services/turns.js';
export {
  BadRequestError,
  chatInputSchema,
  clientFrameSchema,
  createMemorySchema,
  createSessionSchema,
  formatIssues,
  patchConfigSchema,
  type ClientFrame,
} from './schemas.js';
