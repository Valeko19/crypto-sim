import { useRef, useSyncExternalStore } from 'react';
import { getAuthSnapshot, subscribeAuthSnapshot } from '../lib/telegram';

// A child can render from its own local state without rendering AccountApp.
// Bind that state to the mount's generation and gate every personal screen too.
export function useAccountGuard(): boolean {
  const auth = useSyncExternalStore(subscribeAuthSnapshot, getAuthSnapshot);
  const owner = useRef(auth.generation);
  return auth.authenticated && owner.current === auth.generation;
}
