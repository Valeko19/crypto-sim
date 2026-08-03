import { Navigate, Route, Routes } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { MarketScreen } from './screens/MarketScreen';
import { CoinDetailScreen } from './screens/CoinDetailScreen';
import { QuestsScreen } from './screens/QuestsScreen';
import { ShopScreen } from './screens/ShopScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { FarmingScreen } from './screens/FarmingScreen';

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-md pb-20">
      <Routes>
        <Route path="/" element={<Navigate to="/market" replace />} />
        <Route path="/market" element={<MarketScreen />} />
        <Route path="/market/:coinId" element={<CoinDetailScreen />} />
        <Route path="/quests" element={<QuestsScreen />} />
        <Route path="/shop" element={<ShopScreen />} />
        <Route path="/leaderboard" element={<LeaderboardScreen />} />
        <Route path="/farming" element={<FarmingScreen />} />
        <Route path="/profile" element={<ProfileScreen />} />
      </Routes>
      <BottomNav />
    </div>
  );
}
