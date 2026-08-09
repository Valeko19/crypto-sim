import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { resolveIdentity } from '../auth/telegram.js';
import { ensurePlayer } from '../db/queries.js';

declare module 'ws' {
  interface WebSocket {
    playerId?: string;
  }
}

// Browsers can't set custom headers on the WebSocket constructor, and a query
// string on the connect URL would leak the (signed but plaintext) initData
// payload into default access logs — so identity is sent as the first WS
// message instead, right after the client's onopen. Sockets that never send
// a valid auth message get closed after AUTH_TIMEOUT_MS.
const AUTH_TIMEOUT_MS = 5000;

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
      if (ws.playerId) return; // already authed — no other inbound message types today
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'auth') return;
        const identity = resolveIdentity(msg.initData, msg.devPlayerId);
        if (!identity) return ws.close();
        await ensurePlayer(identity.playerId, identity.username);
        ws.playerId = identity.playerId;
        clearTimeout(timeout);
      } catch {
        ws.close();
      }
    });
  });

  return { wss, broadcast, sendToPlayer, getConnectedPlayerIds };
}
