import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { initTelegram, getAuthSnapshot, subscribeAuthSnapshot, getIdentityHeaders, captureAuthContext, isAuthContextCurrent } from './lib/telegram';

initTelegram();

function AccountApp() {
  const auth = React.useSyncExternalStore(subscribeAuthSnapshot, getAuthSnapshot);
  const [failure, setFailure] = React.useState<{ generation: number; message: string } | null>(null);
  React.useEffect(() => {
    const expected = captureAuthContext();
    if (!expected.identity || auth.authenticated) return;
    void getIdentityHeaders(expected).catch(() => {
      if (isAuthContextCurrent(expected)) setFailure({ generation: expected.generation, message: 'Не удалось войти. Переоткройте игру в Telegram.' });
    });
  }, [auth.generation, auth.authenticated]);
  // All screen-local player state (portfolio, quests, staking, bot forms) is
  // discarded together; market data remains in the shared WS store.
  if (!auth.identity) return <div className="p-4 text-muted">Откройте игру из Telegram.</div>;
  if (!auth.authenticated) return <div className="p-4 text-muted">{failure?.generation === auth.generation ? failure.message : 'Авторизация…'}</div>;
  return <App key={auth.generation} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AccountApp />
    </BrowserRouter>
  </React.StrictMode>
);
