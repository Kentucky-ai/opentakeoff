// SPDX-License-Identifier: AGPL-3.0-only
// three.js builders for the 3D view — the only module besides components/View3D.jsx that imports
// three, and it is only ever imported by View3D (a lazy chunk) and the node tests. Kept out of the
// .jsx so web/test/scene3d.test.ts can pin what the default camera shows without a JSX loader.
//
// slabGeometry / ribbonGeometry / planSkinMesh / fitToContent are Kevin Murphy's (OpenTakeoff
// feat/3d-takeoff-view, web/src/components/View3D.jsx, Apache-2.0), with the handedness fix
// applied: the Shape is built from (x, −w) and
// rotateX(−π/2) lands (x, up, +w); the plan skin keeps the default CanvasTexture.flipY so image
// row 0 lands at w = 0. The batch builders (quads, flats, bars, lines, pieces) were added in Michael Edlin's Spline 3D viewer (2026).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildRibbon, planPlane, uvPlanar } from "./scene3d.js";

// ── Kevin's slab / ribbon / plan skin (fixed) ────────────────────────────────────────────────
// uvPeriod [pu, pv] (feet) opts into planar UVs for the grout grid; otherwise the attribute is dropped.
export function slabGeometry(slab, uvPeriod) {
  const shape = new THREE.Shape(slab.verts_ft.map(([x, w]) => new THREE.Vector2(x, -w)));
  for (const hole of slab.holes_ft || []) shape.holes.push(new THREE.Path(hole.map(([x, w]) => new THREE.Vector2(x, -w))));
  const depth = Math.max(slab.z1 - slab.z0, 1e-6);
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, slab.z0, 0);
  if (uvPeriod) {
    const pos = geo.attributes.position, pts = [];
    for (let i = 0; i < pos.count; i++) pts.push([pos.getX(i), pos.getZ(i)]);
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvPlanar(pts, uvPeriod[0], uvPeriod[1]).flat(), 2));
  } else geo.deleteAttribute("uv");
  return geo.index ? geo.toNonIndexed() : geo;
}

// buildRibbon's flat (x,w) quad strip stood up into a closed box spanning z0..z1.
export function ribbonGeometry(ribbon, halfWidth) {
  const { positions } = buildRibbon(ribbon.path_ft, halfWidth);
  const { z0, z1 } = ribbon;
  const verts = [];
  const put = (p, h) => verts.push(p[0], h, p[1]);
  const quad = (a, ah, b, bh, c, ch, d, dh) => { put(a, ah); put(b, bh); put(c, ch); put(a, ah); put(c, ch); put(d, dh); };
  for (let o = 0; o + 12 <= positions.length; o += 12) {
    const aL = [positions[o], positions[o + 1]], bL = [positions[o + 2], positions[o + 3]];
    const bR = [positions[o + 4], positions[o + 5]], aR = [positions[o + 10], positions[o + 11]];
    quad(aL, z1, bL, z1, bR, z1, aR, z1);
    quad(aL, z0, aR, z0, bR, z0, bL, z0);
    quad(aL, z0, aL, z1, bL, z1, bL, z0);
    quad(bL, z0, bL, z1, bR, z1, bR, z0);
    quad(bR, z0, bR, z1, aR, z1, aR, z0);
    quad(aR, z0, aR, z1, aL, z1, aL, z0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

// The page raster as the ground plane. PlaneGeometry + rotateX(−π/2) puts local +Y (uv v = 1) at
// world −Z, and the default CanvasTexture.flipY puts image row 0 at v = 1 — so the image's top
// lands at w = 0 and its bottom at w = hFt, the same +y the shapes use.
export const PLAN_SKIN_OPACITY = 0.45;
export function planSkinMesh(sheet, canvas) {
  const { wFt, hFt, cx, cw } = planPlane(sheet);
  const geo = new THREE.PlaneGeometry(wFt, hFt).rotateX(-Math.PI / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: PLAN_SKIN_OPACITY, depthWrite: false, side: THREE.FrontSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, -0.05, cw);
  mesh.renderOrder = -1;
  mesh.userData.excludeFromFit = true;
  return mesh;
}

export function computeVisibleBox(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const walk = (obj) => {
    if (!obj.visible || obj.userData.excludeFromFit) return;
    if (obj.isInstancedMesh) { obj.computeBoundingBox(); box.union(obj.boundingBox.clone().applyMatrix4(obj.matrixWorld)); }
    else if (obj.isMesh || obj.isLineSegments) {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      if (!obj.geometry.boundingBox.isEmpty()) box.union(obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld));
    }
    for (const c of obj.children) walk(c);
  };
  walk(root);
  return box;
}

// Fit-to-content, near-top-down (a hair off vertical to dodge OrbitControls' pole) so the first
// frame reads as the sheet: north up, east right.
export function fitToContent(camera, controls, root) {
  camera.userData.sectionNear = false;
  const box = computeVisibleBox(root);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = Math.max(sphere.radius / Math.sin((camera.fov * Math.PI) / 360), 0.5) * 1.15;
  camera.position.set(sphere.center.x, sphere.center.y + dist, sphere.center.z + dist * 1e-3);
  camera.up.set(0, 1, 0);
  camera.near = Math.max(dist / 400, 0.02);
  camera.far = dist * 40;
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
}

// ── camera presets: plan, a three-quarter orbit, and square-on to one wall face ──────────────
export function cameraPreset(kind, camera, controls, root, elevation = null) {
  if (kind === "plan") return fitToContent(camera, controls, root);
  if (kind === "sheet" && elevation?.wFt) {
    // the whole page, title block included — top-down, north up (the exhibit / handedness check)
    const c = new THREE.Vector3(elevation.wFt / 2, 0, elevation.hFt / 2);
    const half = Math.max(elevation.hFt / 2, elevation.wFt / 2 / Math.max(camera.aspect, 0.3)) * 1.04;
    const dist = half / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(c.x, dist, c.z + dist * 1e-3);
    camera.up.set(0, 1, 0);
    camera.near = Math.max(dist / 400, 0.02); camera.far = dist * 40; camera.updateProjectionMatrix();
    controls.target.copy(c); controls.update();
    return;
  }
  camera.userData.sectionNear = false;
  if (kind === "orbit") {
    const box = computeVisibleBox(root);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = Math.max(sphere.radius / Math.sin((camera.fov * Math.PI) / 360), 0.5) * 1.05;
    // from the sheet's south-east, 35° up: +x east, +z south
    const dir = new THREE.Vector3(0.55, 0.62, 0.9).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    camera.near = Math.max(dist / 400, 0.02); camera.far = dist * 40; camera.updateProjectionMatrix();
    controls.target.copy(sphere.center); controls.update();
    return;
  }
  if (kind === "elevation" && elevation) {
    const c = new THREE.Vector3(...elevation.center), n = new THREE.Vector3(...elevation.normal).normalize();
    const span = Math.max(elevation.width / Math.max(camera.aspect, 0.3), elevation.height) * 0.5 + 1.5;
    const dist = span / Math.tan((camera.fov * Math.PI) / 360);
    camera.position.copy(c).addScaledVector(n, dist);
    camera.up.set(0, 1, 0);
    // an ELEVATION is a section: whatever stands more than 2 ft in front of the face (the opposite
    // wall of a tub alcove, a partition) is cut away by the near plane, so the face is seen square
    // and whole. Orbiting away restores the normal near plane (View3D, controls "start").
    camera.userData.sectionNear = true;
    camera.userData.sectionPos = camera.position.clone();
    camera.near = Math.max(dist - SECTION_DEPTH_FT, 0.05); camera.far = dist * 40; camera.updateProjectionMatrix();
    controls.target.copy(c); controls.update();
  }
}
export const SECTION_DEPTH_FT = 2;
// the near plane back to normal once the user orbits out of an elevation
export function clearSection(camera, controls) {
  // a click to pick a surface is not an orbit: only a camera that actually moved leaves the section
  if (!camera.userData.sectionNear || !camera.userData.sectionPos || camera.position.distanceTo(camera.userData.sectionPos) < 1e-3) return;
  camera.userData.sectionNear = false;
  camera.near = Math.max(camera.position.distanceTo(controls.target) / 400, 0.02);
  camera.updateProjectionMatrix();
}

// ── batch builders: one merged, non-indexed geometry per batch, with pick ranges ────────────────
// Each builder returns { geometry, ranges: [{ shapeId: pickId, start, count }] } — lib/scene3d.js
// resolveShapeAt walks those ranges from a raycast faceIndex.
function builder(withUv) {
  const pos = [], uv = [], ranges = [];
  let cur = null;
  return {
    begin(pickId) { cur = { shapeId: pickId, start: pos.length / 3, count: 0 }; },
    tri(a, b, c, ua, ub, uc) {
      pos.push(...a, ...b, ...c);
      if (withUv) uv.push(...(ua || [0, 0]), ...(ub || [0, 0]), ...(uc || [0, 0]));
      cur.count += 3;
    },
    end() { if (cur && cur.count) ranges.push(cur); cur = null; },
    done() {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      if (withUv) g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      return { geometry: g, ranges };
    },
  };
}

// quads: [{ pickId, pts:[4 × [x,y,z]], uv?:[4 × [a,b]] }]; uvPeriod [pu, pv] divides the feet UVs
export function quadsGeometry(quads, uvPeriod = null) {
  const b = builder(!!uvPeriod);
  const U = (p) => (uvPeriod && p ? [p[0] / uvPeriod[0], p[1] / uvPeriod[1]] : null);
  for (const q of quads) {
    b.begin(q.pickId || null);
    let [p0, p1, p2, p3] = q.pts, u = q.uv || [];
    // wound to face q.n (the side the tile looks at), so a FrontSide material shows it from there only
    if (q.n) {
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2], bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      const d = (ay * bz - az * by) * q.n[0] + (az * bx - ax * bz) * q.n[1] + (ax * by - ay * bx) * q.n[2];
      if (d < 0) { [p1, p3] = [p3, p1]; u = [u[0], u[3], u[2], u[1]]; }
    }
    b.tri(p0, p1, p2, U(u[0]), U(u[1]), U(u[2]));
    b.tri(p0, p2, p3, U(u[0]), U(u[2]), U(u[3]));
    b.end();
  }
  return b.done();
}

// flats: [{ pickId, ring:[[x,y]], holes:[[[x,y]]], y }] — horizontal polygons with holes
export function flatsGeometry(flats) {
  const b = builder(false);
  for (const f of flats) {
    const contour = f.ring.map(([x, y]) => new THREE.Vector2(x, y));
    const holes = (f.holes || []).map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { tris = []; }
    const all = [...contour, ...holes.flat()];
    b.begin(f.pickId || null);
    for (const [i, j, k] of tris) b.tri([all[i].x, f.y, all[i].y], [all[j].x, f.y, all[j].y], [all[k].x, f.y, all[k].y]);
    b.end();
  }
  return b.done();
}

// planar 3D polygons (tile pieces): project on their dominant plane (Newell normal), triangulate
export function polysGeometry(polys) {
  const b = builder(false);
  for (const p of polys) {
    const P = p.poly3;
    if (!P || P.length < 3) continue;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], c = P[(i + 1) % P.length];
      nx += (a[1] - c[1]) * (a[2] + c[2]); ny += (a[2] - c[2]) * (a[0] + c[0]); nz += (a[0] - c[0]) * (a[1] + c[1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const proj = ax >= ay && ax >= az ? (q) => new THREE.Vector2(q[1], q[2]) : ay >= az ? (q) => new THREE.Vector2(q[0], q[2]) : (q) => new THREE.Vector2(q[0], q[1]);
    // a clipped piece can carry holes (a column smaller than the tile, inside it): holes3, same plane
    const H = (p.holes3 || []).filter((h) => h && h.length >= 3);
    const all = H.length ? [...P, ...H.flat()] : P;
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(P.map(proj), H.map((h) => h.map(proj))); } catch { tris = []; }
    b.begin(p.pickId || null);
    for (const [i, j, k] of tris) b.tri(all[i], all[j], all[k]);
    b.end();
  }
  return b.done();
}

// bars: square-section boxes along a → b (trims). n (optional) orients the square; half = half-size
export function barsGeometry(bars) {
  const b = builder(false);
  const V = (a) => new THREE.Vector3(...a);
  for (const bar of bars) {
    const A = V(bar.a), B = V(bar.b), d = B.clone().sub(A);
    const L = d.length();
    if (!(L > 1e-6)) continue;
    d.divideScalar(L);
    let n = bar.n ? V(bar.n) : new THREE.Vector3(0, 1, 0);
    if (Math.abs(n.dot(d)) > 0.95) n = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    n.sub(d.clone().multiplyScalar(n.dot(d))).normalize();
    const m = new THREE.Vector3().crossVectors(d, n).normalize();
    const h = bar.half;
    // the bar sits on the face (its back on the tile plane), centred across the edge
    const c0 = A.clone().addScaledVector(n, h), c1 = B.clone().addScaledVector(n, h);
    const corner = (c, sn, sm) => c.clone().addScaledVector(n, sn * h).addScaledVector(m, sm * h).toArray();
    const r0 = [corner(c0, -1, -1), corner(c0, 1, -1), corner(c0, 1, 1), corner(c0, -1, 1)];
    const r1 = [corner(c1, -1, -1), corner(c1, 1, -1), corner(c1, 1, 1), corner(c1, -1, 1)];
    b.begin(bar.pickId || null);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; b.tri(r0[i], r0[j], r1[j]); b.tri(r0[i], r1[j], r1[i]); }
    b.tri(r0[0], r0[2], r0[1]); b.tri(r0[0], r0[3], r0[2]); b.tri(r1[0], r1[1], r1[2]); b.tri(r1[0], r1[2], r1[3]);
    b.end();
  }
  return b.done();
}

// lines: [{ a, b, color }] → one LineSegments geometry with vertex colours
export function linesGeometry(lines) {
  const pos = [], col = [];
  const c = new THREE.Color();
  for (const l of lines) {
    pos.push(...l.a, ...l.b);
    c.set(l.color || "#333333");
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// slabs merged per batch, with ranges (ExtrudeGeometry is built per slab, then merged)
export function slabsGeometry(slabs, uvPeriod = null) {
  const parts = [], ranges = [];
  let start = 0;
  for (const s of slabs) {
    const g = slabGeometry(s, uvPeriod);
    const count = g.attributes.position.count;
    ranges.push({ shapeId: s.pickId || `shape:${s.shapeId}`, start, count });
    start += count;
    parts.push(g);
  }
  if (!parts.length) return { geometry: new THREE.BufferGeometry(), ranges };
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) for (const g of parts) g.dispose();
  return { geometry, ranges };
}
export function ribbonsGeometry(ribbons, halfOf) {
  const parts = [], ranges = [];
  let start = 0;
  for (const r of ribbons) {
    const g = ribbonGeometry(r, halfOf(r));
    const count = g.attributes.position.count;
    if (!count) continue;
    ranges.push({ shapeId: `shape:${r.shapeId}`, start, count });
    start += count;
    parts.push(g);
  }
  if (!parts.length) return { geometry: new THREE.BufferGeometry(), ranges };
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) for (const g of parts) g.dispose();
  return { geometry, ranges };
}

// ── the grout grid texture: one repeat of tile + joint (two courses for running bond) ─────────
// uv period = [w + j, h + j] (stacked) or [w + j, 2 (h + j)] (running); returns { texture, period }.
export function groutTexture(grid, tileColor) {
  const pu = grid.wFt + grid.jointFt, pv = (grid.hFt + grid.jointFt) * (grid.pattern === "running" ? 2 : 1);
  const W = 256, H = Math.max(32, Math.min(512, Math.round((W * pv) / pu)));
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return { texture: null, period: [pu, pv] };
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  // grout the tile's own shade (Biscuit on a cream tile) would vanish at room scale: draw it a shade
  // darker when the two are that close, so the joint layout reads — the chip still names the colour
  const lum = (hex) => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
  const groutInk = Math.abs(lum(grid.grout.color) - lum(tileColor)) < 0.15 ? `#${new THREE.Color(grid.grout.color).multiplyScalar(0.62).getHexString()}` : grid.grout.color;
  ctx.fillStyle = groutInk; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = tileColor;
  const jx = Math.max(1, (grid.jointFt / pu) * W), jy = Math.max(1, (grid.jointFt / pv) * H);
  const tw = W - jx, th = (grid.pattern === "running" ? H / 2 : H) - jy;
  ctx.fillRect(jx / 2, jy / 2, tw, th);
  if (grid.pattern === "running") {
    const y = H / 2 + jy / 2;
    ctx.fillRect(jx / 2 - W / 2, y, tw, th);
    ctx.fillRect(jx / 2 + W / 2, y, tw, th);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return { texture, period: [pu, pv] };
}

// the top outline of each slab (ring + holes at z1) — cleaner than EdgesGeometry on merged caps
export function slabOutlines(slabs, color) {
  const pos = [];
  for (const s of slabs) for (const r of [s.verts_ft, ...(s.holes_ft || [])]) {
    for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; pos.push(a[0], s.z1 + 1e-3, a[1], b[0], s.z1 + 1e-3, b[1]); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
}
