/**
 * A symbol picker that puts the symbols you actually use at the top.
 *
 * The broker advertises well over twelve thousand instruments. A flat
 * alphabetical list buries the two or three that matter behind a scroll, so
 * they get their own groups first and the rest follow.
 */
export default function SymbolSelect({ symbols, value, onChange, disabled, includeAll = true }) {
  const tradeable = symbols.filter((s) => s.enabled);
  const watched = symbols.filter((s) => !s.enabled && s.watched);
  const rest = symbols.filter((s) => !s.enabled && !s.watched);

  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      {symbols.length === 0 && <option value="">no symbols — sync first</option>}

      {tradeable.length > 0 && (
        <optgroup label={`Tradeable (${tradeable.length})`}>
          {tradeable.map((s) => (
            <option key={s.id} value={s.id}>{s.broker_symbol} ●</option>
          ))}
        </optgroup>
      )}

      {watched.length > 0 && (
        <optgroup label={`Watched (${watched.length})`}>
          {watched.map((s) => (
            <option key={s.id} value={s.id}>{s.broker_symbol} ◦</option>
          ))}
        </optgroup>
      )}

      {includeAll && rest.length > 0 && (
        <optgroup label={`All instruments (${rest.length})`}>
          {rest.map((s) => (
            <option key={s.id} value={s.id}>{s.broker_symbol}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
