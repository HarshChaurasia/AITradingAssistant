import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

export default function CandleChart({ candles, height = 420 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: 'transparent' }, textColor: '#9aa7bc' },
      grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2d3748' },
      timeScale: { borderColor: '#2d3748', timeVisible: true, secondsVisible: false }
    });

    seriesRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444'
    });
    chartRef.current = chart;

    const resize = () =>
      chart.applyOptions({ width: containerRef.current?.clientWidth ?? 600 });
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!seriesRef.current) return;

    // lightweight-charts wants seconds since epoch, and our API sends ISO UTC.
    seriesRef.current.setData(
      candles.map((c) => ({
        time: Math.floor(new Date(c.open_time).getTime() / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} className="chart-container" />;
}
