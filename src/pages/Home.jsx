import { useEffect, useState } from 'react';
import Scene from '../components/Scene.jsx';
import Hud from '../components/Hud.jsx';
import Dock from '../components/Dock.jsx';

const INITIAL_HUD = {
  heading: '000°', walked: '0.0 m', o2: '98%', status: 'Walking', seated: false,
  deer: 'Grazing', dog: 'Following', auto: true, lamp: true, follow: true
};

// Home page: the Lantern Walk 3D scene with its telemetry HUD and control dock.
export default function Home() {
  const [engine, setEngine] = useState(null);
  const [failed, setFailed] = useState(false);
  const [hud, setHud] = useState(INITIAL_HUD);
  const [hintVisible, setHintVisible] = useState(true);

  useEffect(() => {
    const id = setTimeout(() => setHintVisible(false), 10000);
    return () => clearTimeout(id);
  }, []);

  return (
    <>
      <Scene onReady={setEngine} onError={() => setFailed(true)} onHud={setHud} />

      {!engine && (
        <div className="loading">
          <div>
            <b>Astro Walk</b>
            {failed
              ? 'This scene needs WebGL, which your browser could not start. Try a recent Chrome, Edge, Firefox or Safari.'
              : 'Growing the meadow and planting the pines…'}
          </div>
        </div>
      )}

      <div className="tag">
        <h1>Lantern <span>Walk</span></h1>
        <p>
          An astronaut and his dog Kepler cross a moonlit meadow ringed by tall pines, where deer graze,
          squirrels forage and a crashed spacecraft still burns, walking out to sit on a ledge at the
          cliff edge and watch the full moon.
        </p>
      </div>

      <Hud hud={hud} />

      <div className="hint" style={{ opacity: hintVisible ? 1 : 0 }}>
        Drag to orbit · scroll or pinch to zoom · WASD / arrow keys to walk him yourself · E to sit at the ledge
      </div>

      <Dock engine={engine} hud={hud} />
    </>
  );
}
