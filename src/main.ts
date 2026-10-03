import { App } from './App';
import { t } from './ui/i18n';

const app = new App();
app.boot().catch((err) => {
  console.error(err);
  app.renderer?.setAnimationLoop(null);
  app.video.pause();
  app.ui.menu('hidden');
  const el = document.getElementById('unsupported');
  if (el) {
    el.textContent = t('loadError');
    el.classList.add('is-visible');
  }
});

if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;

if (import.meta.env.DEV) {
  /** dev: stand at feet position x y z and look at a point */
  (window as unknown as { lookAt: unknown }).lookAt = (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
    const dx = tx - x;
    const dz = tz - z;
    const p = app.player.position.clone().set(x, y, z);
    app.player.teleport(p, Math.atan2(-dx, -dz), Math.atan2(ty - (y + 1.6), Math.hypot(dx, dz)));
  };
}

if (import.meta.env.DEV) {
  /** dev: walk a list of xz waypoints holding W, report where it gets stuck */
  (window as unknown as { autopilot: unknown }).autopilot = (points: Array<[number, number]>, run = false) =>
    new Promise((resolve) => {
      const p = app.player;
      const keys = app.input.keys;
      let i = 0;
      let last = p.position.clone();
      let still = 0;
      const log: string[] = [];
      const tick = () => {
        if (i >= points.length) {
          keys.delete('KeyW');
          keys.delete('ShiftLeft');
          resolve({ ok: true, log, end: p.position.toArray().map((v) => +v.toFixed(2)) });
          return;
        }
        const [x, z] = points[i];
        const dx = x - p.position.x;
        const dz = z - p.position.z;
        if (Math.hypot(dx, dz) < 0.7) {
          log.push(`reached ${i} at y=${p.position.y.toFixed(2)}`);
          i++;
        }
        p.setLook(Math.atan2(-dx, -dz), 0);
        keys.add('KeyW');
        if (run) keys.add('ShiftLeft');
        still = p.position.distanceTo(last) < 0.02 ? still + 1 : 0;
        last = p.position.clone();
        if (still > 90) {
          keys.delete('KeyW');
          keys.delete('ShiftLeft');
          resolve({ ok: false, stuckAt: p.position.toArray().map((v) => +v.toFixed(2)), target: i, log });
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
}
