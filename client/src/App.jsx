import { useEffect, useState } from 'react';
import Markets from './pages/Markets';
import Backtests from './pages/Backtests';
import Signals from './pages/Signals';
import Risk from './pages/Risk';
import Trades from './pages/Trades';
import Login from './pages/Login';
import Scanner from './pages/Scanner';
import Performance from './pages/Performance';
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
          <button className={view === 'backtests' ? 'nav active' : 'nav'} onClick={() => setView('backtests')}>Backtests</button>
          <button className={view === 'execution' ? 'nav active' : 'nav'} onClick={() => setView('execution')}>Execution</button>
          <button className={view === 'risk' ? 'nav active' : 'nav'} onClick={() => setView('risk')}>Risk</button>
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
          : view === 'scanner' ? <Scanner />
          : view === 'signals' ? <Signals />
          : view === 'execution' ? <Trades />
          : view === 'risk' ? <Risk />
          : <Performance />}
      </main>
    </div>
  );
}

function StatCard({ title, value, tone }) {
  return (
    <div className={`stat-card ${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
