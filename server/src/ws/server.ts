import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

export function createWsServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  function broadcast(type: string, payload: unknown) {
    const message = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'connected', payload: {} }));
  });

  return { wss, broadcast };
}
