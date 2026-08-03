import { NavLink } from 'react-router-dom';
import { TradeIcon, QuestsIcon, ShopIcon, FarmingIcon, ProfileIcon } from './icons';

const TABS = [
  { to: '/market', label: 'Торговля', Icon: TradeIcon },
  { to: '/quests', label: 'Задания', Icon: QuestsIcon },
  { to: '/shop', label: 'Магазин', Icon: ShopIcon },
  { to: '/farming', label: 'Фарминг', Icon: FarmingIcon },
  { to: '/profile', label: 'Профиль', Icon: ProfileIcon },
];

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-md items-stretch justify-between px-2">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] transition-colors ${
                isActive ? 'text-accent-to' : 'text-muted'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={`h-6 w-6 ${isActive ? '[filter:drop-shadow(0_0_6px_rgba(124,111,240,0.65))]' : ''}`} />
                <span className={isActive ? 'font-medium text-white' : ''}>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
