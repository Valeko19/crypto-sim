// STUB: real rate/limits will be governed by the Telegram Stars Invoice API later.
export const STARS_TO_USDD_RATE = 10; // 1 star = $10
export const DAILY_LIMIT_USDD = 10_000;

export interface ShopPackage {
  id: string;
  usddAmount: number;
  stars: number;
  bonusPct: number;
  popular?: boolean;
}

export const SHOP_PACKAGES: ShopPackage[] = [
  { id: 'pkg_1000', usddAmount: 1_000, stars: 100, bonusPct: 0 },
  { id: 'pkg_5000', usddAmount: 5_000, stars: 450, bonusPct: 11, popular: true },
  { id: 'pkg_25000', usddAmount: 25_000, stars: 2_000, bonusPct: 25 },
  { id: 'pkg_100000', usddAmount: 100_000, stars: 7_000, bonusPct: 43 },
  { id: 'pkg_1000000000', usddAmount: 1_000_000_000, stars: 62_500_000, bonusPct: 60 },
];
