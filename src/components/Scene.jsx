import { useEffect, useRef } from 'react';
import { createScene } from '../scene/engine.js';

// Owns the <canvas>. The engine is imperative, so React only mounts it once
// and tears it down on unmount; everything else flows through callbacks.
export default function Scene({ onReady, onError, onHud }) {
  const stageRef = useRef(null);
  // Keep the latest onHud without restarting the engine when the prop changes.
  const onHudRef = useRef(onHud);
  onHudRef.current = onHud;

  useEffect(() => {
    let engine = null;
    // Defer one tick so the loading screen paints before the heavy scene build.
    const id = setTimeout(() => {
      try {
        engine = createScene(stageRef.current, { onHud: hud => onHudRef.current(hud) });
        onReady(engine);
      } catch (err) {
        console.error(err);
        onError(err);
      }
    }, 40);

    return () => {
      clearTimeout(id);
      if (engine) engine.dispose();
      onReady(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="stage" ref={stageRef} />;
}
