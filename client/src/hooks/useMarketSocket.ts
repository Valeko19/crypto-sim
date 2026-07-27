import { useSyncExternalStore, useEffect } from 'react';
import { ensureWsStarted, subscribe, getSnapshot } from '../lib/wsStore';

export function useMarketSocket() {
  useEffect(() => {
    ensureWsStarted();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot);
}
