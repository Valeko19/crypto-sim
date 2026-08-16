// Minimal HTTP client for driving a running crypto-sim server from
// standalone test scripts. Deliberately talks only over HTTP (no direct DB
// or in-process imports of engine code) so these tests exercise exactly the
// same surface a real client would, and could in principle point at any
// running instance via TEST_SERVER_URL — though see the safety note in
// index.ts: this is meant for a LOCAL DEV server only.
const DEFAULT_BASE = process.env.TEST_SERVER_URL ?? 'http://localhost:8787';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status} ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export interface Client {
  playerId: string;
  baseUrl: string;
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
  // Non-throwing variants for tests that specifically want to assert a
  // rejection (4xx/401/403) rather than treat it as a broken test run.
  tryGet(path: string): Promise<{ status: number; body: any }>;
  tryPost(path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

async function rawFetch(
  baseUrl: string,
  method: string,
  path: string,
  playerId: string | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (playerId) headers['X-Dev-Player-Id'] = playerId;
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // empty/non-JSON body — leave json as null
  }
  return { status: res.status, body: json };
}

export function makeClient(playerId: string, baseUrl: string = DEFAULT_BASE): Client {
  return {
    playerId,
    baseUrl,
    async get(path) {
      const { status, body } = await rawFetch(baseUrl, 'GET', path, playerId);
      if (status < 200 || status >= 300) throw new ApiError(status, body);
      return body;
    },
    async post(path, body) {
      const { status, body: respBody } = await rawFetch(baseUrl, 'POST', path, playerId, body);
      if (status < 200 || status >= 300) throw new ApiError(status, respBody);
      return respBody;
    },
    tryGet: path => rawFetch(baseUrl, 'GET', path, playerId),
    tryPost: (path, body) => rawFetch(baseUrl, 'POST', path, playerId, body),
  };
}

// No player-id header at all (or custom headers) — for probing auth gating
// directly, e.g. against a separately-spawned production-mode server.
export function rawGet(baseUrl: string, path: string, headers: Record<string, string> = {}) {
  return rawFetch(baseUrl, 'GET', path, null, undefined, headers);
}
export function rawPost(baseUrl: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return rawFetch(baseUrl, 'POST', path, null, body, headers);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fresh, namespaced per test run so re-running the suite never collides with
// a previous run's quest/rank claims (those are permanent per player).
export function uniquePlayerId(tag: string, runId: string): string {
  return `dev_test_${runId}_${tag}`;
}
