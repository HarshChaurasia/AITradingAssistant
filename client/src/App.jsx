import { useEffect, useState } from 'react';
import Markets from './pages/Markets';
import Backtests from './pages/Backtests';
import Lab from './pages/Lab';
import Signals from './pages/Signals';
import Risk from './pages/Risk';
import Trades from './pages/Trades';
import Login from './pages/Login';
import Scanner from './pages/Scanner';
import Performance from './pages/Performance';
import Settings from './pages/Settings';
import Strategies from './pages/Strategies';
import Missed from './pages/Missed';
import Scalping from './pages/Scalping';
import { api } from './api';

function App() {
  const [view, setView] = useState('overview');
  const [auth, setAuth] = useState({ checked: false, username: null });

  useEffect(() => {
    api.authStatus()
      .then((s) => setAuth({ checked: true, username: s.authenticated ? s.username : null }))
      .catch(() => setAuth({ checked: true, username: null }));
  }, []);

  if (!auth.checked) return <div className="login-shell"><p className="muted">Loading…</p></div>;
  if (!auth.username) return <Login onSignedIn={(username) => setAuth({ checked: true, username })} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">TradePilot</div>
        <nav>
          <button className={view === 'overview' ? 'nav active' : 'nav'} onClick={() => setView('overview')}>Performance</button>
          <button className={view === 'markets' ? 'nav active' : 'nav'} onClick={() => setView('markets')}>Markets</button>
          <button className={view === 'scanner' ? 'nav active' : 'nav'} onClick={() => setView('scanner')}>Scanner</button>
          <button className={view === 'signals' ? 'nav active' : 'nav'} onClick={() => setView('signals')}>Signals</button>
          <button className={view === 'missed' ? 'nav active' : 'nav'} onClick={() => setView('missed')}>Missed signals</button>
          <button className={view === 'strategies' ? 'nav active' : 'nav'} onClick={() => setView('strategies')}>Strategies</button>
          <button className={view === 'scalping' ? 'nav active' : 'nav'} onClick={() => setView('scalping')}>Scalping</button>
          <button className={view === 'backtests' ? 'nav active' : 'nav'} onClick={() => setView('backtests')}>Backtests</button>
          <button className={view === 'lab' ? 'nav active' : 'nav'} onClick={() => setView('lab')}>Strategy Lab</button>
          <button className={view === 'execution' ? 'nav active' : 'nav'} onClick={() => setView('execution')}>Execution</button>
          <button className={view === 'risk' ? 'nav active' : 'nav'} onClick={() => setView('risk')}>Risk</button>
          <button className={view === 'settings' ? 'nav active' : 'nav'} onClick={() => setView('settings')}>Settings</button>
        </nav>
      </aside>

      <main className="content">
        <header className="topbar">
          <h1>Trading Dashboard</h1>
          <div className="topbar-right">
            <span className="status-pill">System online</span>
            <button
              className="link"
              onClick={() => api.logout().then(() => setAuth({ checked: true, username: null }))}
            >
              sign out ({auth.username})
            </button>
          </div>
        </header>

        {view === 'markets' ? <Markets />
          : view === 'backtests' ? <Backtests />
          : view === 'lab' ? <Lab />
          : view === 'scanner' ? <Scanner />
          : view === 'signals' ? <Signals />
          : view === 'missed' ? <Missed />
          : view === 'strategies' ? <Strategies />
          : view === 'scalping' ? <Scalping />
          : view === 'settings' ? <Settings />
          : view === 'execution' ? <Trades />
          : view === 'risk' ? <Risk />
          : <Performance />}
      </main>
    </div>
  );
}

export default App;
