const ROWS = [
  ['Heading', h => h.heading],
  ['Walked', h => h.walked],
  ['Lantern', h => (h.lamp ? 'ON' : 'OFF'), 'warm'],
  ['Status', h => h.status],
  ['Kepler', h => h.dog],
  ['Birds', h => h.birds],
  ['Deer', h => h.deer],
  ['Suit O₂', h => h.o2],
];

export default function Hud({ hud }) {
  return (
    <dl className="hud" aria-label="Suit telemetry">
      {ROWS.map(([label, get, cls]) => [
        <dt key={label + '-t'}>{label}</dt>,
        <dd key={label + '-d'} className={cls}>{get(hud)}</dd>,
      ])}
    </dl>
  );
}
