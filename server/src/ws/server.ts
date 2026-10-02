import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { resolveIdentity } from '../auth/telegram.js';
import { isAuthSessionValid, resolveAuthSession } from '../auth/sessions.js';
import { isBetaAllowed, BETA_DENIED_MESSAGE } from '../auth/beta.js';
import { ensurePlayer, getPlayer } from '../db/queries.js';

declare module 'ws' {
  interface WebSocket {
    playerId?: string;
    sessionToken?: string;
    sessionRecheck?: NodeJS.Timeout;
  }
}

// Browsers can't set custom headers on the WebSocket constructor, and a query
// string on the connect URL would leak the (signed but plaintext) initData
// payload into default access logs — so identity is sent as the first WS
// message instead, right after the client's onopen. Sockets that never send
// a valid auth message get closed after AUTH_TIMEOUT_MS.
const AUTH_TIMEOUT_MS = 5000;
const SESSION_RECHECK_MS = 5 * 60 * 1000;

export function createWsServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  function broadcast(type: string, payload: unknown) {
    const message = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  // A player might have multiple tabs/devices open — send to every matching
  // connected socket, not just one.
  function sendToPlayer(playerId: string, type: string, payload: unknown) {
    const message = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && client.playerId === playerId) client.send(message);
    }
  }

  function getConnectedPlayerIds(): Set<string> {
    const ids = new Set<string>();
    for (const client of wss.clients) if (client.playerId) ids.add(client.playerId);
    return ids;
  }

  wss.on('connection', ws => {
    const timeout = setTimeout(() => {
      if (!ws.playerId) ws.close();
    }, AUTH_TIMEOUT_MS);

    ws.send(JSON.stringify({ type: 'connected', payload: {} }));

    ws.on('message', async raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (ws.playerId) {
          if (msg.type === 'activity' && ws.sessionToken) {
            const identity = await resolveAuthSession(ws.sessionToken).catch(() => null);
            if (!identity) {
              ws.send(JSON.stringify({ type: 'auth_error', payload: { error: 'unauthorized' } }));
              ws.close();
            }
          }
          return;
        }
        if (msg.type !== 'auth') return;
        const sessionToken = typeof msg.sessionToken === 'string' ? msg.sessionToken : undefined;
        const identity = sessionToken
          ? await resolveAuthSession(sessionToken)
          : resolveIdentity(undefined, msg.devPlayerId);
        if (!identity) {
          ws.send(JSON.stringify({ type: 'auth_error', payload: { error: 'unauthorized' } }));
          return ws.close();
        }

        // Same beta-gate as the REST middleware — applied here too so it
        // can't be bypassed by connecting straight over WS instead of REST.
        const existing = await getPlayer(identity.playerId);
        if (!existing && !isBetaAllowed(identity)) {
          ws.send(JSON.stringify({ type: 'auth_error', payload: { error: BETA_DENIED_MESSAGE } }));
          return ws.close();
        }

        await ensurePlayer(identity.playerId, identity.username);
        ws.playerId = identity.playerId;
        if (sessionToken) {
          ws.sessionToken = sessionToken;
          ws.sessionRecheck = setInterval(async () => {
            if (ws.readyState !== WebSocket.OPEN || !ws.sessionToken) return;
            const isValid = await isAuthSessionValid(ws.sessionToken).catch(() => false);
            if (!isValid) {
              ws.send(JSON.stringify({ type: 'auth_error', payload: { error: 'unauthorized' } }));
              ws.close();
            }
          }, SESSION_RECHECK_MS);
        }
        clearTimeout(timeout);
      } catch {
        ws.close();
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (ws.sessionRecheck) clearInterval(ws.sessionRecheck);
    });
  });

  return { wss, broadcast, sendToPlayer, getConnectedPlayerIds };
}
