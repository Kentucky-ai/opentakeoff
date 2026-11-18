// SPDX-License-Identifier: AGPL-3.0-only
// 3D takeoff view — a lazy overlay that stands the sheet's takeoff up in three.js.
//
// Based on Kevin Murphy's OpenTakeoff 3D takeoff view (knmurphy/opentakeoff feat/3d-takeoff-view,
// web/src/components/View3D.jsx). Copyright 2026 Kevin N. Murphy and the OpenTakeoff contributors,
// licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modified by Michael Edlin in the Spline 3D viewer (2026) and ported back to OpenTakeoff under
// AGPL-3.0-only: the handedness fix (no north-south mirror); an accuracy panel (click a surface →
// its condition, SF/LF and source; isolate a room or a unit; plan / orbit / sheet cameras; PNG
// exhibit export); stairs (treads, risers, nosings, landings) and the level above stacked at the
// floor-to-floor; grout grids on tile floors; batched meshes with pick ranges. The scene is built
// from OpenTakeoff's own shapes and conditions (lib/scene3dTakeoff.js). Kevin's doctrine is kept: a
// read-only projection — nothing here feeds back into a quantity. Axis contract: world
// (x, up, +y_ft), lib/scene3d.js.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildTakeoffScene } from "../lib/scene3dTakeoff.js";
import { isolate3D, isolateRooms, unitRoomsOf, hostRoomOf } from "../lib/scene3dScope.js";
import { resolveShapeAt, RIBBON_HALF_FT, FLUSH_HALF_FT, POST_RADIUS_FT, EXCLUDED_COLOR, planPlane as planPlaneOf } from "../lib/scene3d.js";
import { slabsGeometry, ribbonsGeometry, quadsGeometry, barsGeometry, planSkinMesh, cameraPreset, slabOutlines, groutTexture } from "../lib/scene3dThree.js";
import { tileGridOf } from "../lib/scene3dTile.js";
import { Z, S } from "../lib/ui.js";

const LIMITATIONS_TEXT = "Schematic 3D from the takeoff — not as-built. Walls are the traced runs (no thickness); stair side walls are context, not a quantity. Verify in the field.";
const EXPORT_CAVEAT = "schematic 3D from the takeoff — not as-built; context shown is not a quantity; verify in field";
const LAYERS = [
  ["floor", "Floors"], ["ceiling", "Ceilings (at their height · soffits · grid)"], ["base", "Base · transitions · walls · posts"], ["context", "Context (stair side walls)"],
  ["stair", "Stairs (treads · risers · nosings · landings)"], ["level", "Level above (stacked sheet)"], ["plan", "Plan underlay"],
];
const POST_GEOMETRY = new THREE.CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0);
const CLICK_MAX_TRAVEL_PX = 5, CLICK_MAX_MS = 450;

const ribbonHalf = (r) => (r.mode === "flush" ? FLUSH_HALF_FT : RIBBON_HALF_FT);
function groupBy(list, keyOf) { const m = new Map(); for (const it of list) { const k = keyOf(it); (m.get(k) || m.set(k, []).get(k)).push(it); } return m; }
function disposeTree(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose(); m.dispose(); }
  });
}
function visibleChain(o) { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; }

export default function View3D({
  shapes, conditions, sheetId, sheet, sheetLabel, projectName, scaleLabel,
  planSkin, hiddenConds, initialSelectedId, onSelectShape, onClose,
  levelSheets = [], upperSheetId = null, upperSkin = null, onPickUpperSheet = null,
}) {
  const mountRef = useRef(null);
  const engineRef = useRef(null);
  const layerGroupsRef = useRef(new Map());
  const highlightRef = useRef(null);
  const planRef = useRef(null);
  const upperRef = useRef(null);
  const [upperOpacity, setUpperOpacity] = useState(0.35);
  const [levelFt, setLevelFt] = useState(null);             // floor-to-floor typed in the panel; null = the stair's top
  const fittedRef = useRef(false);
  const [hidden, setHidden] = useState(() => new Set(hiddenConds || []));
  const [layers, setLayers] = useState(() => Object.fromEntries(LAYERS.map(([k]) => [k, true])));
  const [picked, setPicked] = useState(null);                  // pickId
  const [focus, setFocus] = useState({ mode: "all", ids: null, label: "" });
  const [preset, setPreset] = useState("plan");
  const [presetTick, setPresetTick] = useState(0);            // re-applies a preset clicked twice
  const applyPreset = (p) => { setPreset(p); setPresetTick((t) => t + 1); };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [lost, setLost] = useState(false);
  const [perf, setPerf] = useState({ sceneMs: 0, meshMs: 0, frameMs: 0, fps: 0, triangles: 0, calls: 0 });

  const built = useMemo(() => {
    const t0 = performance.now();
    try {
      const data = buildTakeoffScene({ shapes, conditions, sheetId, sheet });
      return { data, ms: performance.now() - t0 };
    } catch (err) { return { error: err.message, ms: performance.now() - t0 }; }
  }, [shapes, conditions, sheetId, sheet.widthPx, sheet.heightPx, sheet.upp]); // eslint-disable-line react-hooks/exhaustive-deps
  const scene = built.data;
  const sheetShapes = useMemo(() => shapes.filter((s) => s.sheet_id === sheetId), [shapes, sheetId]);
  const cById = useMemo(() => new Map(conditions.map((c) => [c.id, c])), [conditions]);
  const pickInfo = picked && scene ? scene.info.get(picked) : null;
  const pickedShapeId = pickInfo?.shapeId || null;

  // conditions actually drawn on this sheet (legend)
  const legend = useMemo(() => {
    if (!scene) return [];
    const ids = new Set();
    for (const l of [scene.slabs, scene.ribbons, scene.posts, scene.stairs?.quads || [], scene.ceilings?.slabs || []]) for (const it of l) if (it.condId) ids.add(it.condId);
    return conditions.filter((c) => ids.has(c.id));
  }, [scene, conditions]);
  // ── mount: renderer, camera, controls, lights, picking, the render loop ──
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xf4f5f7, 1);
    mount.appendChild(renderer.domElement);
    const threeScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    threeScene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const head = new THREE.DirectionalLight(0xffffff, 1.6);
    head.position.set(0.35, 0.55, 1);
    camera.add(head); camera.add(head.target); head.target.position.set(0, 0, -1);
    threeScene.add(camera);
    engineRef.current = { renderer, scene: threeScene, camera, controls };
    // dev builds only: lets a scripted review set an exact elevation camera (headless drags don't orbit)
    if (import.meta.env.DEV) window.__ot3dEngine = engineRef.current;
    const resize = () => { const w = mount.clientWidth || 1, h = mount.clientHeight || 1; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(mount);
    const onLost = (e) => { e.preventDefault(); setLost(true); };
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pickAt = (cx, cy) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const targets = [];
      threeScene.traverse((o) => { if ((o.userData.ranges || o.userData.pickIds) && visibleChain(o)) targets.push(o); });
      for (const hit of raycaster.intersectObjects(targets, false)) {
        if (hit.object.isInstancedMesh) { const id = hit.object.userData.pickIds?.[hit.instanceId]; if (id) return id; continue; }
        const id = resolveShapeAt(hit.object.userData.ranges, hit.faceIndex);
        if (id) return id;
      }
      return null;
    };
    let down = null;
    const onDown = (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; };
    const onUp = (e) => {
      const d = down; down = null;
      if (e.button !== 0 || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_MAX_TRAVEL_PX || performance.now() - d.t >= CLICK_MAX_MS) return;
      setPicked(pickAt(e.clientX, e.clientY));
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    // the canvas underneath keeps its own key bindings (⌫ deletes the selection): while 3D is open
    // no key reaches it — Esc closes the view instead (Kevin's destructive-key gate, contained here)
    const onKey = (e) => {
      const inOverlay = mount.parentNode?.contains(e.target);
      if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); onCloseRef.current?.(); return; }
      if (inOverlay && /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || "")) { e.stopImmediatePropagation(); return; }
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);

    let raf, frames = 0, acc = 0, last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      const t = performance.now();
      renderer.render(threeScene, camera);
      acc += performance.now() - t; frames++;
      if (t - last > 1000 && frames > 0) {
        const info = renderer.info.render, fps = (frames * 1000) / (t - last), cpu = acc / frames;
        setPerf((p) => ({ ...p, fps: Math.round(fps), frameMs: Math.round(cpu * 100) / 100, triangles: info.triangles, calls: info.calls }));
        window.__ot3dPerf = { fps, renderCpuMs: cpu, triangles: info.triangles, calls: info.calls };
        frames = 0; acc = 0; last = t;
      }
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKey, true);
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      disposeTree(threeScene);
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      engineRef.current = null;
      layerGroupsRef.current.clear();
    };
  }, []);
  // the plan underlay (the page raster, feet-true, unmirrored)
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (planRef.current) { e.scene.remove(planRef.current); disposeTree(planRef.current); planRef.current = null; }
    if (!planSkin?.canvas) return;
    const mesh = planSkinMesh(sheet, planSkin.canvas);
    mesh.material.map.anisotropy = Math.min(8, e.renderer.capabilities.getMaxAnisotropy());
    mesh.visible = layers.plan;
    e.scene.add(mesh);
    planRef.current = mesh;
  }, [planSkin, sheet.widthPx, sheet.heightPx, sheet.upp]); // eslint-disable-line react-hooks/exhaustive-deps

  // the level above: another sheet's raster stacked at the floor-to-floor (the stair's top unless
  // typed). Registered by the PAGE FRAME — right when both sheets print the plan in the same place
  // (the usual floor-plan set); the panel says so.
  const levelAt = levelFt > 0 ? levelFt : scene?.stairs?.topFt || 0;
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (upperRef.current) { e.scene.remove(upperRef.current); disposeTree(upperRef.current); upperRef.current = null; }
    if (!upperSkin?.canvas || !(levelAt > 0)) return;
    const mesh = planSkinMesh(sheet, upperSkin.canvas);
    mesh.position.y = levelAt;
    mesh.material.opacity = upperOpacity;
    mesh.material.side = THREE.DoubleSide;
    mesh.visible = layers.level !== false;
    e.scene.add(mesh);
    upperRef.current = mesh;
  }, [upperSkin, levelAt, sheet.widthPx, sheet.heightPx, sheet.upp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (upperRef.current) upperRef.current.material.opacity = upperOpacity; }, [upperOpacity]);

  // ── content: one group per layer; batches per material; rebuilt on data / hide / focus ──
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !scene) return;
    const t0 = performance.now();
    for (const g of layerGroupsRef.current.values()) { e.scene.remove(g); disposeTree(g); }
    layerGroupsRef.current.clear();
    const groups = new Map(LAYERS.filter(([k]) => k !== "plan").map(([k]) => [k, new THREE.Group()]));
    const keep = (it) => !hidden.has(it.condId) && (!focus.ids || !it.shapeId || focus.ids.has(it.shapeId));
    const mat = (color, { opacity = 1, map = null, lines = false, overlay = false } = {}) => (lines
      ? new THREE.LineBasicMaterial({ vertexColors: true, transparent: opacity < 1, opacity })
      : new THREE.MeshLambertMaterial({ color: map ? 0xffffff : color, map, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
        polygonOffset: overlay, polygonOffsetFactor: overlay ? -2 : 0, polygonOffsetUnits: overlay ? -2 : 0 }));
    const addMesh = (layer, { geometry, ranges }, material, edges = false) => {
      if (!geometry.attributes.position?.count) { geometry.dispose(); material.dispose(); return null; }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.ranges = ranges.filter((r) => r.shapeId);
      if (edges) {
        const em = new THREE.LineBasicMaterial({ color: new THREE.Color(material.color).multiplyScalar(0.55), transparent: true, opacity: 0.8 });
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), em));
      }
      groups.get(layer).add(mesh);
      return mesh;
    };
    const texCache = new Map();
    const gridFor = (condId) => {
      if (!condId) return null;
      if (texCache.has(condId)) return texCache.get(condId);
      const c = cById.get(condId), g = tileGridOf(c);
      const v = g ? groutTexture(g, c?.color || "#cccccc") : null;
      texCache.set(condId, v?.texture ? v : null);
      return texCache.get(condId);
    };
    // floors (per condition; tile floors carry the grout grid), excluded volumes, laid floor pieces
    for (const [condId, list] of groupBy(scene.slabs.filter((s) => s.kind === "floor" && keep(s)), (s) => s.condId)) {
      const c = cById.get(condId);
      const gt = list.some((s) => s.grid) ? gridFor(condId) : null;
      const fm = addMesh("floor", slabsGeometry(list, gt ? gt.period : null), mat(c?.color || "#888888", { map: gt?.texture || null }));
      if (fm) fm.add(slabOutlines(list, new THREE.Color(c?.color || "#888888").multiplyScalar(0.5)));
    }
    const excl = scene.slabs.filter((s) => s.kind === "excluded" && keep(s));
    if (excl.length) addMesh("floor", slabsGeometry(excl), mat(EXCLUDED_COLOR, { opacity: 0.4 }), true);
    // ceilings: a plane at the ceiling height (ACT grid on it), soffit drops down to it — see-through
    // so the floors read beneath
    for (const [condId, list] of groupBy((scene.ceilings?.slabs || []).filter(keep), (s) => s.condId)) {
      const c = cById.get(condId), spec = list[0].gridSpec;
      const gt = spec ? groutTexture(spec, c?.color || "#d9dcdf") : null;
      const cm = addMesh("ceiling", slabsGeometry(list, gt?.texture ? gt.period : null), mat(c?.color || "#d9dcdf", { map: gt?.texture || null, opacity: 0.72 }));
      if (cm) cm.add(slabOutlines(list, new THREE.Color(c?.color || "#888888").multiplyScalar(0.5)));
    }
    for (const [, list] of groupBy((scene.ceilings?.quads || []).filter(keep), (q) => q.color)) addMesh("ceiling", quadsGeometry(list), mat(list[0].color, { opacity: 0.8 }), true);
    // base / transitions / posts
    for (const [key, list] of groupBy(scene.ribbons.filter(keep), (r) => `${r.condId}|${r.translucent ? 1 : 0}`)) {
      const c = cById.get(list[0].condId);
      addMesh("base", ribbonsGeometry(list, ribbonHalf), mat(c?.color || "#555555", { opacity: key.endsWith("|1") ? 0.45 : 1 }), true);
    }
    for (const [condId, list] of groupBy(scene.posts.filter(keep), (p) => p.condId)) {
      const inst = new THREE.InstancedMesh(POST_GEOMETRY, mat(cById.get(condId)?.color || "#555555"), list.length);
      const m = new THREE.Matrix4();
      list.forEach((p, i) => { m.makeScale(POST_RADIUS_FT, Math.max(p.z1 - p.z0, 1e-3), POST_RADIUS_FT).setPosition(p.pt_ft[0], p.z0, p.pt_ft[1]); inst.setMatrixAt(i, m); });
      inst.instanceMatrix.needsUpdate = true;
      inst.userData.pickIds = list.map((p) => `shape:${p.shapeId}`);
      groups.get("base").add(inst);
    }
    // stairs: treads / risers / landings in the condition colour, stringers grey, wall sides as context, nosings as bars
    for (const [, list] of groupBy((scene.stairs?.quads || []).filter(keep), (q) => `${q.layer}|${q.color}`)) {
      const q0 = list[0];
      if (q0.layer === "context") addMesh("context", quadsGeometry(list), mat(q0.color, { opacity: 0.22 }));
      else addMesh("stair", quadsGeometry(list), mat(q0.color), true);
    }
    for (const [color, list] of groupBy((scene.stairs?.bars || []).filter(keep), (b) => b.color)) addMesh("stair", barsGeometry(list), mat(color));
    // the level above: its slab edge at the floor-to-floor, so the level reads at any opacity
    const lvl = levelFt > 0 ? levelFt : scene.stairs?.topFt || 0;
    if (lvl > 0) {
      const { wFt, hFt, cx, cw } = planPlaneOf(sheet);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(wFt, 0.01, hFt)), new THREE.LineBasicMaterial({ color: 0x2bb5c0 }));
      edge.position.set(cx, lvl, cw);
      edge.userData.excludeFromFit = true;
      groups.get("level").add(edge);
    }
    for (const [k, g] of groups) { g.visible = layers[k] !== false; e.scene.add(g); layerGroupsRef.current.set(k, g); }
    if (!fittedRef.current) { cameraPreset("plan", e.camera, e.controls, e.scene); fittedRef.current = true; }
    const meshMs = performance.now() - t0;
    setPerf((p) => ({ ...p, sceneMs: Math.round(built.ms), meshMs: Math.round(meshMs) }));
    if (typeof window !== "undefined") window.__ot3dBuild = { sceneMs: built.ms, meshMs, stats: scene.stats, notes: scene.notes.map((n) => n.text) };
  }, [scene, hidden, focus, levelFt]); // eslint-disable-line react-hooks/exhaustive-deps

  // layer toggles: visibility only
  useEffect(() => {
    for (const [k, g] of layerGroupsRef.current) g.visible = layers[k] !== false;
    if (planRef.current) planRef.current.visible = layers.plan;
    if (upperRef.current) upperRef.current.visible = layers.level !== false;
  }, [layers]);

  // camera presets
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !scene) return;
    if (preset === "plan" || preset === "orbit") cameraPreset(preset, e.camera, e.controls, e.scene);
    else if (preset === "sheet") cameraPreset("sheet", e.camera, e.controls, e.scene, { wFt: sheet.widthPx * sheet.upp, hFt: sheet.heightPx * sheet.upp });
  }, [preset, presetTick, scene]);

  // selection highlight: the picked item's own triangles, lifted and tinted
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (highlightRef.current) { highlightRef.current.parent?.remove(highlightRef.current); disposeTree(highlightRef.current); highlightRef.current = null; }
    if (!picked) return;
    const pos = [];
    e.scene.traverse((o) => {
      if (!o.userData.ranges || !visibleChain(o)) return;
      const src = o.geometry.attributes.position;
      for (const r of o.userData.ranges) if (r.shapeId === picked) for (let i = r.start; i < r.start + r.count; i++) pos.push(src.getX(i), src.getY(i), src.getZ(i));
      if (o.userData.pickIds) o.userData.pickIds.forEach((id, i) => {
        if (id !== picked) return;
        const m = new THREE.Matrix4(); o.getMatrixAt(i, m);
        const g = POST_GEOMETRY.clone().applyMatrix4(m).toNonIndexed();
        const p = g.attributes.position; for (let k = 0; k < p.count; k++) pos.push(p.getX(k), p.getY(k), p.getZ(k));
        g.dispose();
      });
    });
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
    mesh.renderOrder = 10;
    mesh.userData.excludeFromFit = true;
    e.scene.add(mesh);
    highlightRef.current = mesh;
  }, [picked, scene, hidden, focus, layers]);

  // a canvas selection when the view opened is the first pick
  useEffect(() => { if (initialSelectedId) setPicked(`shape:${initialSelectedId}`); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pickedShapeId) onSelectShape?.(pickedShapeId); }, [pickedShapeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isolate = (mode) => {
    if (mode === "all" || !pickedShapeId) { setFocus({ mode: "all", ids: null, label: "" }); return; }
    const room = hostRoomOf(pickedShapeId, sheetShapes);
    if (mode === "room") {
      const ids = room ? isolate3D(room, sheetShapes) : isolate3D(pickedShapeId, sheetShapes);
      const f = sheetShapes.find((s) => s.id === room);
      setFocus({ mode, ids, label: `room ${f?.label || cById.get(f?.condition_id)?.finish_tag || room || ""} — ${ids?.size || 0} shapes` });
    } else {
      const u = unitRoomsOf(room || pickedShapeId, sheetShapes, conditions);
      if (!u) return;
      const ids = isolateRooms(u.roomIds, sheetShapes, [pickedShapeId]);
      setFocus({ mode, ids, label: `unit ${u.key} (${u.by === "connected" ? "rooms connected, same ×N" : u.by.replace("_", " ")}) — ${u.roomIds.size} rooms, ${ids.size} shapes` });
    }
    fittedRef.current = false;
  };
  useEffect(() => { const e = engineRef.current; if (e && !fittedRef.current && scene) { cameraPreset(preset === "sheet" ? "plan" : preset, e.camera, e.controls, e.scene); fittedRef.current = true; } }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportPng = () => {
    const e = engineRef.current;
    if (!e) return;
    e.renderer.render(e.scene, e.camera);
    const raw = e.renderer.domElement.toDataURL("image/png");
    const img = new Image();
    img.onload = () => {
      const legendRows = legend.filter((c) => !hidden.has(c.id)).map((c) => [c.color, c.finish_tag]);
      const perRow = Math.max(1, Math.floor(img.width / 230));
      const footerH = 58 + Math.ceil(legendRows.length / perRow) * 20;
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height + footerH;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0);
      ctx.fillStyle = "#0d1526"; ctx.font = "bold 14px sans-serif";
      ctx.fillText(`${projectName || ""}${projectName ? " · " : ""}${sheetLabel || sheetId} · ${scaleLabel || `${sheet.upp} ft/px`} · ${new Date().toLocaleDateString()}${focus.ids ? ` · ${focus.label}` : ""}`, 14, img.height + 20);
      ctx.font = "12px sans-serif"; ctx.fillStyle = "#44506a";
      ctx.fillText(EXPORT_CAVEAT, 14, img.height + 38);
      legendRows.forEach(([color, text], i) => {
        const x = 14 + (i % perRow) * 230, y = img.height + 52 + Math.floor(i / perRow) * 20;
        ctx.fillStyle = color || "#888"; ctx.fillRect(x, y, 12, 12);
        ctx.fillStyle = "#0d1526"; ctx.fillText(String(text).slice(0, 32), x + 18, y + 11);
      });
      const a = document.createElement("a");
      a.href = cv.toDataURL("image/png");
      a.download = `${(sheetLabel || "sheet").replace(/[^\w.-]+/g, "_")}-3d.png`;
      a.click();
    };
    img.src = raw;
  };

  const row = { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12.5 };
  const btn = (on) => ({ padding: "4px 8px", fontSize: 12, cursor: "pointer", border: `1px solid ${on ? "var(--cobalt)" : "var(--ink-faint)"}`, background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--paper-bright)" : "var(--ink)" });
  const st = scene?.stats;
  return (
    <div data-view3d="1" style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: "var(--ink)", display: "flex" }}>
      <div ref={mountRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {lost && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(13,21,38,.8)", color: "#fff", zIndex: 2 }}>
            The graphics context was lost (GPU reset). Close the 3D view and open it again.
          </div>
        )}
        {pickInfo && (
          <div data-pick-chip="1" style={{ position: "absolute", left: 12, top: 12, maxWidth: 420, ...S.chip, flexDirection: "column", alignItems: "flex-start", gap: 3, borderRadius: 0, padding: "8px 10px", boxShadow: "var(--shadow-2)", zIndex: 1, whiteSpace: "normal" }}>
            <strong style={{ fontSize: 12.5 }}>{pickInfo.title}</strong>
            {pickInfo.rows.map(([k, v]) => <div key={k} style={{ fontSize: 11.5 }}><span style={{ color: "var(--ink-muted)" }}>{k}:</span> {v}</div>)}
            <div style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{pickInfo.source}</div>
          </div>
        )}
      </div>
      <div style={{ width: 300, background: "var(--paper-bright)", color: "var(--ink)", borderLeft: "1px solid var(--ink-faint)", overflow: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ ...S.panelSection, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 14 }}>3D · {sheetLabel || sheetId}</strong>
          <button onClick={onClose} className="btn-ghost" style={{ padding: "3px 8px" }} title="Close (Esc)">×</button>
        </div>
        {built.error ? <div style={{ ...S.panelSection, color: "var(--c-danger)", fontSize: 12.5 }}>{built.error}</div> : (
          <>
            <div style={S.panelSection}>
              <div style={S.monoLabel}>View</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                <button style={btn(preset === "plan")} onClick={() => applyPreset("plan")}>Plan</button>
                <button style={btn(preset === "orbit")} onClick={() => applyPreset("orbit")}>Orbit</button>
                <button style={btn(preset === "sheet")} onClick={() => applyPreset("sheet")} title="The whole sheet from above, title block included">Sheet</button>
                <button style={btn(false)} onClick={exportPng} title="Download a PNG exhibit with the sheet, scale, date, legend and caveat">Export PNG</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 6 }}>Click a surface to see what it is · drag to orbit, right-drag to pan, scroll to zoom</div>
            </div>
            <div style={S.panelSection}>
              <div style={S.monoLabel}>Isolate</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button style={btn(focus.mode === "room")} disabled={!pickedShapeId} onClick={() => isolate("room")} title="The picked surface's room and everything in it">Room</button>
                <button style={btn(focus.mode === "unit")} disabled={!pickedShapeId} onClick={() => isolate("unit")} title="Every room of the picked surface's unit">Unit</button>
                <button style={btn(focus.mode === "all")} onClick={() => isolate("all")}>All</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 4 }}>{focus.ids ? focus.label : pickedShapeId ? "picked — isolate its room or unit" : "pick a surface first"}</div>
            </div>
            <div style={S.panelSection}>
              <div style={S.monoLabel}>Layers</div>
              {LAYERS.map(([k, label]) => (
                <label key={k} style={row}><input type="checkbox" checked={layers[k] !== false} onChange={() => setLayers((l) => ({ ...l, [k]: !(l[k] !== false) }))} />{label}</label>
              ))}
              {planSkin?.canvas ? null : <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>plan underlay loading…</div>}
            </div>
            {(scene?.stairs?.stairIds?.size > 0 || levelSheets.length > 0) && (
              <div style={S.panelSection} data-level-above>
                <div style={S.monoLabel}>Level above</div>
                <label style={{ ...row, flexDirection: "column", alignItems: "stretch", gap: 3 }}>sheet
                  <select value={upperSheetId || ""} onChange={(ev) => onPickUpperSheet?.(ev.target.value || null)} style={{ fontSize: 11 }}>
                    <option value="">— none —</option>
                    {levelSheets.filter((x) => x.id !== sheetId).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </label>
                <label style={row}>floor-to-floor (ft)
                  <input type="number" step="0.25" min="0" style={{ width: 64, fontSize: 11 }} value={levelFt ?? ""} placeholder={scene?.stairs?.topFt ? String(scene.stairs.topFt) : ""}
                    onChange={(ev) => setLevelFt(ev.target.value === "" ? null : Number(ev.target.value))} />
                </label>
                <label style={row}>opacity <input type="range" min="0.05" max="1" step="0.05" value={upperOpacity} onChange={(ev) => setUpperOpacity(Number(ev.target.value))} /></label>
                <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>
                  {levelAt > 0 ? `at ${levelAt}' ${levelFt > 0 ? "(typed)" : "(top of the stair)"}` : "no stair top yet — type the floor-to-floor"}
                  {upperSheetId ? (upperSkin?.canvas ? " · stacked by page position: the stair lines should meet; if they don't, the sheets are drawn in different places" : " · loading…") : ""}
                </div>
              </div>
            )}
            <div style={S.panelSection}>
              <div style={S.monoLabel}>Conditions</div>
              {legend.map((c) => (
                <label key={c.id} style={row}>
                  <input type="checkbox" checked={!hidden.has(c.id)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
                  <span style={{ width: 10, height: 10, background: c.color, display: "inline-block", flexShrink: 0 }} />{c.finish_tag}
                </label>
              ))}
              {!legend.length && <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>Nothing measured on this sheet.</div>}
            </div>
            <div style={S.panelSection}>
              <div style={S.monoLabel}>On this sheet</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.6, fontFamily: "var(--f-mono)" }}>
                {st.floors} floors · {st.ribbons} lines · {st.posts} posts<br />
                {st.flights} stair flights · {st.landings} landings<br />
                {st.ceilings} ceilings · {st.soffits} soffits{st.ceilingAllowances ? ` · ${st.ceilingAllowances} at the 9'-0" ALLOWANCE` : ""}<br />
                build {perf.sceneMs} + {perf.meshMs} ms · {perf.fps || 0} fps · {perf.calls} draws · {Math.round((perf.triangles || 0) / 1000)}k tris
              </div>
            </div>
            {scene.notes.length > 0 && (
              <div style={S.panelSection}>
                <div style={S.monoLabel}>Notes</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                  {scene.notes.map((n, i) => <span key={`${n.kind}:${n.tag}:${i}`} style={{ ...S.chip, width: "fit-content", whiteSpace: "normal", borderRadius: 0 }}>{n.text}</span>)}
                </div>
              </div>
            )}
          </>
        )}
        <div style={{ ...S.panelSection, marginTop: "auto", fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.5 }}>
          {LIMITATIONS_TEXT} 3D view by Kevin Murphy and Michael Edlin.
        </div>
      </div>
    </div>
  );
}
