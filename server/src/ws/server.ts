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
  async function sendToPlayer(playerId: string, type: string, payload: unknown) {
    const message = JSON.stringify({ type, payload });
    await Promise.all([...wss.clients].map(async client => {
      if (client.readyState !== WebSocket.OPEN || client.playerId !== playerId) return;
      // Outbound updates are not player activity and must not slide idle expiry.
      const token = client.sessionToken;
      const valid = !token || await isAuthSessionValid(token).catch(() => false);
      if (client.readyState !== WebSocket.OPEN || client.playerId !== playerId || client.sessionToken !== token) return;
      if (!valid) {
        rejectSession(client);
        return;
      }
      client.send(message);
    }));
  }

  function rejectSession(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'auth_error', payload: { error: 'unauthorized' } }));
    ws.close();
  }

  function getConnectedPlayerIds(): Set<string> {
    const ids = new Set<string>();
    for (const client of wss.clients) if (client.playerId) ids.add(client.playerId);
    return ids;
  }

  wss.on('connection', ws => {
    let authInProgress = false;
    let closed = false;
    const timeout = setTimeout(() => {
      if (!ws.playerId) ws.close();
    }, AUTH_TIMEOUT_MS);

    ws.send(JSON.stringify({ type: 'connected', payload: {} }));

    ws.on('message', async raw => {
      try {
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        const msg = JSON.parse(raw.toString());
        if (ws.playerId) {
          if (msg.type === 'activity' && ws.sessionToken) {
            const identity = await resolveAuthSession(ws.sessionToken).catch(() => null);
            if (!identity) rejectSession(ws);
          }
          return;
        }
        if (msg.type !== 'auth' || authInProgress) return;
        // EventEmitter does not serialize async listeners: lock before any await.
        authInProgress = true;
        const sessionToken = typeof msg.sessionToken === 'string' ? msg.sessionToken : undefined;
        const identity = sessionToken
          ? await resolveAuthSession(sessionToken)
          : resolveIdentity(undefined, msg.devPlayerId);
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        if (!identity) {
          rejectSession(ws);
          return;
        }

        // Same beta-gate as the REST middleware — applied here too so it
        // can't be bypassed by connecting straight over WS instead of REST.
        const existing = await getPlayer(identity.playerId);
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        if (!existing && !isBetaAllowed(identity)) {
          ws.send(JSON.stringify({ type: 'auth_error', payload: { error: BETA_DENIED_MESSAGE } }));
          return ws.close();
        }

        await ensurePlayer(identity.playerId, identity.username);
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        ws.playerId = identity.playerId;
        if (sessionToken) {
          ws.sessionToken = sessionToken;
          ws.sessionRecheck = setInterval(async () => {
            if (ws.readyState !== WebSocket.OPEN || !ws.sessionToken) return;
            const isValid = await isAuthSessionValid(ws.sessionToken).catch(() => false);
            if (!isValid) rejectSession(ws);
          }, SESSION_RECHECK_MS);
        }
        clearTimeout(timeout);
      } catch {
        ws.close();
      }
    });

    ws.on('close', () => {
      closed = true;
      clearTimeout(timeout);
      if (ws.sessionRecheck) clearInterval(ws.sessionRecheck);
      ws.sessionRecheck = undefined;
    });
  });

  return { wss, broadcast, sendToPlayer, getConnectedPlayerIds };
}
