import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function EquityCurve({ equity, height = 240 }) {
  const data = (equity || []).map((value, index) => ({ trade: index, balance: Number(value.toFixed(2)) }));

  if (data.length <= 1) return <p className="muted">No closed trades to chart.</p>;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
        <XAxis dataKey="trade" stroke="#9aa7bc" label={{ value: 'trade #', fill: '#9aa7bc', dy: 12 }} />
        <YAxis stroke="#9aa7bc" domain={['auto', 'auto']} />
        <Tooltip contentStyle={{ background: '#0f1724', border: '1px solid #2d3748' }} />
        <Line type="monotone" dataKey="balance" stroke="#67e8f9" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
