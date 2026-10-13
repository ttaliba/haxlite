/**
 * The `ws` package, loaded with a CJS `require` on purpose.
 *
 * `ws` is CommonJS behind an ESM wrapper (`wrapper.mjs`). Importing it from
 * ESM makes Node run cjs-module-lexer over each of its modules and detect
 * their format before evaluating them: ≈ 20 ms of extra startup on the
 * benchmark VM (cold `import('ws')` ≈ 55–65 ms vs `require('ws')` ≈ 33–36 ms
 * from the same ES module). The values and types are the same.
 */
import { createRequire } from 'node:module';
import type * as Ws from 'ws';

const ws = createRequire(import.meta.url)('ws') as typeof Ws;

export const WebSocket = ws.WebSocket;
export type WebSocket = Ws.WebSocket;
export const WebSocketServer = ws.WebSocketServer;
export type WebSocketServer = Ws.WebSocketServer;
export type ClientOptions = Ws.ClientOptions;
export type RawData = Ws.RawData;
