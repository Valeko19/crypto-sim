let marketTail: Promise<void> = Promise.resolve();

export function withMarketLock<T>(work: () => Promise<T> | T): Promise<T> {
  const result = marketTail.then(work, work);
  marketTail = result.then(() => undefined, () => undefined);
  return result;
}