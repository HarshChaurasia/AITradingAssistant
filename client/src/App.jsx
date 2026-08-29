import { useEffect, useState } from 'react';
import Markets from './pages/Markets';
import Backtests from './pages/Backtests';
import Signals from './pages/Signals';
import Risk from './pages/Risk';
import Trades from './pages/Trades';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const chartData = [
  { name: 'Mon', value: 100 },
  { name: 'Tue', value: 108 },
  { name: 'Wed', value: 112 },
  { name: 'Thu', value: 120 },
  { name: 'Fri', value: 126 },
  { name: 'Sat', value: 133 },
  { name: 'Sun', value: 140 }
];

function App() {
  const [view, setView] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [news, setNews] = useState([]);

  useEffect(() => {
    const load = async () => {
      const [overviewRes, newsRes] = await Promise.all([
        fetch('/api/overview'),
        fetch('/api/news'),
      ]);

      setOverview(await overviewRes.json());
      setNews(await newsRes.json());
    };

    load();
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">TradePilot</div>
        <nav>
          <button className={view === 'overview' ? 'nav active' : 'nav'} onClick={() => setView('overview')}>Overview</button>
          <button className={view === 'markets' ? 'nav active' : 'nav'} onClick={() => setView('markets')}>Markets</button>
          <button className={view === 'signals' ? 'nav active' : 'nav'} onClick={() => setView('signals')}>Signals</button>
          <button className={view === 'backtests' ? 'nav active' : 'nav'} onClick={() => setView('backtests')}>Backtests</button>
          <button className={view === 'execution' ? 'nav active' : 'nav'} onClick={() => setView('execution')}>Execution</button>
          <button className={view === 'risk' ? 'nav active' : 'nav'} onClick={() => setView('risk')}>Risk</button>
        </nav>
      </aside>

      <main className="content">
        <header className="topbar">
          <h1>Trading Dashboard</h1>
          <div className="status-pill">System online</div>
        </header>

        {view === 'markets' ? <Markets />
          : view === 'backtests' ? <Backtests />
          : view === 'signals' ? <Signals />
          : view === 'execution' ? <Trades />
          : view === 'risk' ? <Risk />
          : (<>

        <section className="stats-grid">
          <StatCard title="Account Value" value={`$${overview?.accountValue ?? 0}`} tone="blue" />
          <StatCard title="Daily P&L" value={`$${overview?.dailyPnL ?? 0}`} tone="green" />
          <StatCard title="Total P&L" value={`$${overview?.totalPnl ?? 0}`} tone="purple" />
          <StatCard title="Win Rate" value={`${overview?.winRate ?? 0}%`} tone="orange" />
        </section>

        <section className="panel-grid two-col">
          <div className="panel">
            <div className="panel-header">
              <h3>Portfolio curve</h3>
              <span>Past 7 days</span>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
                  <XAxis dataKey="name" stroke="#9aa7bc" />
                  <YAxis stroke="#9aa7bc" />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#67e8f9" strokeWidth={3} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3>Risk controls</h3>
              <span>Auto-gated</span>
            </div>
            <ul className="risk-list">
              <li><span>Max risk/trade</span><strong>1.0%</strong></li>
              <li><span>Daily loss cap</span><strong>5.0%</strong></li>
              <li><span>Open trades</span><strong>{overview?.openTrades ?? 0}</strong></li>
              <li><span>Strategy confidence</span><strong>{overview?.confidence ?? 0}%</strong></li>
            </ul>
          </div>
        </section>

        <section className="panel-grid two-col">

          <div className="panel">
            <div className="panel-header">
              <h3>News</h3>
              <span>Impact</span>
            </div>
            <div className="list-block compact">
              {news.map(item => (
                <div key={item.id} className="news-item">
                  <strong>{item.title}</strong>
                  <small>{item.source} • {item.time}</small>
                  <span className="impact">{item.impact}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel-grid bottom-grid">
        </section>

        </>)}
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
