import { useEffect, useRef, useState } from 'react';

// The engine (and three.js with it) is a separate chunk. Requesting it as soon as this module loads lets it download
// while React paints the page, instead of holding the whole page back until the 3D code has arrived.
const engineModule = import('../scene/engine.js');

// Owns the <canvas>. The engine is imperative, so React only mounts it once
// and tears it down on unmount; everything else flows through callbacks.
export default function Scene({ onReady, onError, onHud, onProgress }) {
  const stageRef = useRef(null);
  const [shown, setShown] = useState(false);
  // Keep the latest callbacks without restarting the engine when the props change.
  const cb = useRef({ onHud, onProgress });
  cb.current = { onHud, onProgress };

  useEffect(() => {
    let engine = null, cancelled = false;
    (async () => {
      try {
        const { createScene } = await engineModule;
        if (cancelled) return;
        const e = await createScene(stageRef.current, {
          onHud: hud => cb.current.onHud(hud),
          onProgress: (f, label) => cb.current.onProgress?.(f, label),
          isCancelled: () => cancelled
        });
        if (cancelled) { e.dispose(); return; }
        engine = e;
        setShown(true);
        onReady(e);
      } catch (err) {
        if (cancelled || err.cancelled) return;
        console.error(err);
        onError(err);
      }
    })();

    return () => {
      cancelled = true;
      if (engine) engine.dispose();
      onReady(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={shown ? 'stage shown' : 'stage'} ref={stageRef} />;
}
