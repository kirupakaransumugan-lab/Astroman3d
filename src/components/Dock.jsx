import { useState } from 'react';

function Slider({ id, label, min, max, step, value, onChange }) {
  return (
    <label htmlFor={id}>
      {label}
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

// Buttons show their pressed state from the HUD snapshot, because the engine can
// change it on its own (pressing WASD switches auto-walk off). Clicks use the
// engine's toggles so they never act on a stale snapshot.
export default function Dock({ engine, hud }) {
  const [glow, setGlow] = useState(1);
  const [moon, setMoon] = useState(1);
  const [clouds, setClouds] = useState(0.55);
  const [rain, setRain] = useState(0.3);
  const disabled = !engine;

  return (
    <div className="dock" role="toolbar" aria-label="Scene controls">
      <button aria-pressed={hud.auto} disabled={disabled} onClick={() => engine.toggleAuto()}>
        {hud.auto ? 'Auto-walk' : 'Walk: you'}
      </button>
      <button aria-pressed={hud.lamp} disabled={disabled} onClick={() => engine.toggleLamp()}>
        Lantern
      </button>
      <button aria-pressed={hud.follow} disabled={disabled} onClick={() => engine.toggleFollow()}>
        {hud.follow ? 'Follow cam' : 'Free cam'}
      </button>
      <button disabled={disabled} onClick={() => engine.moonView()}>Moon view</button>
      <button disabled={disabled} onClick={() => engine.toggleSit()}>
        {hud.seated ? 'Stand up' : 'Sit at edge'}
      </button>
      <Slider id="glow" label="Lamp" min={0.3} max={2} step={0.05} value={glow}
        onChange={v => { setGlow(v); engine?.setGlow(v); }} />
      <Slider id="moonlight" label="Moon" min={0.3} max={2} step={0.05} value={moon}
        onChange={v => { setMoon(v); engine?.setMoonGain(v); }} />
      <Slider id="clouds" label="Clouds" min={0} max={1} step={0.05} value={clouds}
        onChange={v => { setClouds(v); engine?.setClouds(v); }} />
      <Slider id="rain" label="Rain" min={0} max={1} step={0.05} value={rain}
        onChange={v => { setRain(v); engine?.setRain(v); }} />
    </div>
  );
}
