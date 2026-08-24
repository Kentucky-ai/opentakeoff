// Net engine worker — owns the built nets (they hold closures, so they never
// cross the thread boundary); the canvas sends geometry once per sheet and
// asks for rooms by point.
import { buildNet, netRoomAt } from "./netroom";

const nets = new Map();
self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === "build") {
      const t0 = performance.now();
      const net = buildNet({ segs: m.segs, meta: m.meta, subpaths: m.subpaths }, m.ftPx, m.texts);
      nets.set(m.key, net);
      self.postMessage({ type: "built", key: m.key, req: m.req, ms: Math.round(performance.now() - t0), faces: net.arr.faces.length, starved: !!net.starved });
    } else if (m.type === "room") {
      const net = nets.get(m.key);
      if (!net) { self.postMessage({ type: "room", req: m.req, error: "no net" }); return; }
      const r = netRoomAt(net, m.x, m.y, m.ftPx);
      self.postMessage({ type: "room", req: m.req, room: r ? { ring: r.ring, holes: r.holes, areaPx: r.areaPx, faces: r.faces, starved: !!r.starved } : null });
    } else if (m.type === "drop") {
      nets.delete(m.key);
    }
  } catch (err) {
    self.postMessage({ type: m.type === "build" ? "built" : "room", key: m.key, req: m.req, error: String(err && err.message || err) });
  }
};
