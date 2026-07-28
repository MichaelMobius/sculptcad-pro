import * as THREE from 'three';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { $, on, createUIRefs } from './core/dom.js';
import { createInitialState } from './core/state.js';
import { createSceneRuntime } from './core/sceneRuntime.js';
import { SCULPT_WELD_EPSILON, SCULPT_RADIUS_TO_SCREEN_PX, MIN_SCULPT_RADIUS_PX } from './core/constants.js';
import { makeTextureCanvas, createMaterial, createMatcapMaterial, disposeRecordMaterials, setMaterialUI, disposeTextureSet, sampleCanvasBaseColor, hexToRgba } from './core/materials.js';
import { disposeWireframeOverlay, setRecordWireframe, rebuildRecordWireframe } from './core/wireframe.js';
import { addHistoryEntry as addBudgetedHistoryEntry, clearHistoryStack as clearBudgetedHistoryStack, trimUndoHistory as trimBudgetedUndoHistory } from './history/historyBudget.js';
import { cloneTypedArray, setIndexAttribute } from './utils/buffers.js';
import { downloadBlob } from './io/download.js';
import { applySculptTool } from './sculpt/ToolRegistry.js';
import { geometryStats, localSubdivideGeometry } from './utils/remesh.js';

// ─── Vectores temporales reutilizables ───────────────────────────────────────
// Evitan alocación de objetos por frame (patrón SculptGL).
// SIN ESTAS DECLARACIONES la escultura lanza ReferenceError en el primer trazo.
const tmpV            = new THREE.Vector3();
const tmpV2           = new THREE.Vector3();
const tmpV3           = new THREE.Vector3();
const tmpM            = new THREE.Matrix4();
const tmpWorld        = new THREE.Vector3();
const tmpWorld2       = new THREE.Vector3();
const tmpLocal        = new THREE.Vector3();
const tmpLocal2       = new THREE.Vector3();
const tmpNormal       = new THREE.Vector3();
const tmpToCamera     = new THREE.Vector3();
const tmpScale        = new THREE.Vector3();
const tmpQ            = new THREE.Quaternion();
const tmpNormalMatrix = new THREE.Matrix3();
// ─────────────────────────────────────────────────────────────────────────────

const ui = createUIRefs();
const { canvas, viewport, statusEl, brushPreview } = ui;
setMaterialUI(ui);
const state = createInitialState();
let meshWorker = null;
let meshWorkerSeq = 1;
const meshWorkerJobs = new Map();
const paintBrushCache = new Map();
const rasterVectorState = {
  sourceName: '',
  sourceCanvas: document.createElement('canvas'),
  mask: null,
  width: 0,
  height: 0,
  rawLoops: [],
  loops: [],
  svg: '',
  bounds: null,
  aspect: 1
};
rasterVectorState.sourceCtx = rasterVectorState.sourceCanvas.getContext('2d', { willReadFrequently: true });

// RAF batching: almacena el evento más reciente de escultura/pintura y cursor.
// animate() los procesa una vez por frame en lugar de por cada pointermove.
let pendingSculptEvent = null;
let pendingPaintEvent  = null;
let pendingCursorEvent = null;

const {
  scene,
  camera,
  renderer,
  orbit,
  transform,
  raycaster,
  pointer,
  brushRing,
  brushDot
} = createSceneRuntime({
  canvas,
  onTransformDraggingChanged: (event) => { orbit.enabled = !event.value; },
  onTransformMouseDown: () => {
    if (!state.selected) return;
    state.transformDragStart = state.selected.position.clone();
    state.transformDragAxis = transform.axis || null;
    pushObjectHistory('Transformar objeto');
  },
  onTransformMouseUp: () => {
    state.transformDragStart = null;
    state.transformDragAxis = null;
    updateDimensionInputs();
    renderObjectList();
  },
  onTransformObjectChange: () => {
    constrainTransformToActiveAxes();
    if (transform.getMode && transform.getMode() === 'translate') {
      applySnapping(transform.dragging ? (transform.axis || state.transformDragAxis) : null);
    }
    updateDimensionInputs();
    renderObjectList();
  }
});

const TOOL_META = {
  select:  { label: 'Seleccionar', icon: '↖', workspace: 'model', hint: 'Haz clic en una pieza para editarla.', primary: '<strong>Clic izquierdo:</strong> seleccionar objeto', secondary: '<strong>Clic derecho:</strong> orbitar · <strong>rueda:</strong> zoom' },
  move:    { label: 'Mover', icon: '↔', workspace: 'model', hint: 'Arrastra las flechas del gizmo para cambiar la posición.', primary: '<strong>Arrastra una flecha:</strong> mover en un eje', secondary: '<strong>W:</strong> mover · <strong>grilla:</strong> controla el ajuste' },
  rotate:  { label: 'Rotar', icon: '⟳', workspace: 'model', hint: 'Arrastra los anillos del gizmo para rotar la pieza.', primary: '<strong>Arrastra un anillo:</strong> rotar objeto', secondary: '<strong>E:</strong> rotar · <strong>clic derecho:</strong> orbitar' },
  scale:   { label: 'Escalar', icon: '⤢', workspace: 'model', hint: 'Arrastra los manejadores o introduce medidas exactas.', primary: '<strong>Arrastra un manejador:</strong> escalar', secondary: '<strong>R:</strong> escalar · usa X/Y/Z para medidas exactas' },
  sculpt:  { label: 'Esculpir', icon: '●', workspace: 'sculpt', hint: 'Arrastra sobre la superficie para deformarla.', primary: '<strong>Clic y arrastra:</strong> aplicar el pincel', secondary: '<strong>Shift:</strong> suavizar · <strong>Ctrl:</strong> máscara · <strong>Alt:</strong> invertir' },
  paint:   { label: 'Pintar', icon: '✎', workspace: 'paint', hint: 'Pinta directamente sobre la superficie del objeto.', primary: '<strong>Clic y arrastra:</strong> pintar textura', secondary: '<strong>P:</strong> pintar · cambia color, tamaño y opacidad en el panel' },
  measure: { label: 'Medir', icon: '⌖', workspace: 'model', hint: 'Marca dos puntos para conocer la distancia.', primary: '<strong>Primer clic:</strong> inicio · <strong>segundo clic:</strong> final', secondary: '<strong>Esc:</strong> cancelar medición · <strong>M:</strong> medir' }
};

const WORKSPACE_HINTS = {
  model: 'Agrega una forma, selecciónala y ajusta posición o medidas.',
  sculpt: 'Prepara la malla y elige un pincel para modificar el volumen.',
  paint: 'Aplica color y material directamente sobre la superficie.',
  export: 'Elige GLB para conservar color o STL para impresión 3D.'
};

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.title = text;
}

function hideStartupSplash() {
  const splash = document.getElementById('startupSplash');
  if (!splash) return;
  splash.classList.add('is-hidden');
  window.setTimeout(() => splash.remove(), 320);
}

function updateContextUI() {
  const meta = TOOL_META[state.tool] || TOOL_META.select;
  if (ui.activeToolName) ui.activeToolName.textContent = meta.label;
  if (ui.activeToolIcon) ui.activeToolIcon.textContent = meta.icon;
  if (ui.workspaceHint) ui.workspaceHint.textContent = state.workspace === 'export' ? WORKSPACE_HINTS.export : meta.hint;
  if (ui.hudPrimary) ui.hudPrimary.innerHTML = meta.primary;
  if (ui.hudSecondary) ui.hudSecondary.innerHTML = meta.secondary;
}

function setWorkspace(workspace, { syncTool = true, scroll = true } = {}) {
  const next = ['model', 'sculpt', 'paint', 'export'].includes(workspace) ? workspace : 'model';
  state.workspace = next;
  document.querySelectorAll('[data-workspace-btn]').forEach((button) => {
    const active = button.dataset.workspaceBtn === next;
    button.classList.toggle('active', active);
    if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-workspaces]').forEach((element) => {
    const allowed = element.dataset.workspaces.split(',').map((value) => value.trim());
    element.hidden = !(allowed.includes('all') || allowed.includes(next));
  });

  if (syncTool) {
    if (next === 'sculpt' && state.tool !== 'sculpt') setTool('sculpt', { syncWorkspace: false });
    else if (next === 'paint' && state.tool !== 'paint') setTool('paint', { syncWorkspace: false });
    else if (next === 'export' && state.tool !== 'select') setTool('select', { syncWorkspace: false });
    else if (next === 'model' && ['sculpt', 'paint'].includes(state.tool)) setTool('select', { syncWorkspace: false });
  }
  if (ui.workspaceHint && next === 'export') ui.workspaceHint.textContent = WORKSPACE_HINTS.export;
  try { localStorage.setItem('scp-workspace', next); } catch {}
  if (scroll) document.querySelector('.inspector')?.scrollTo({ top: 0, behavior: 'smooth' });
  updateContextUI();
}

function updateRangeOutputs() {
  if (ui.brushRadiusValue) ui.brushRadiusValue.value = Number(ui.brushRadius.value).toFixed(2);
  if (ui.brushStrengthValue) ui.brushStrengthValue.value = Number(ui.brushStrength.value).toFixed(3);
  if (ui.creasePinchValue) ui.creasePinchValue.value = `${Math.round(Number(ui.creasePinch?.value || 1) * 100)}%`;
  if (ui.creaseDepthValue) ui.creaseDepthValue.value = `${Math.round(Number(ui.creaseDepth?.value || 1) * 100)}%`;
  if (ui.dynamicTopoValue) ui.dynamicTopoValue.value = Number(ui.dynamicTopoEdge.value).toFixed(2);
  if (ui.paintRadiusValue) ui.paintRadiusValue.value = `${Math.round(Number(ui.paintRadius.value))} px`;
  if (ui.paintOpacityValue) ui.paintOpacityValue.value = `${Math.round(Number(ui.paintOpacity.value) * 100)}%`;
  if (ui.metalnessValue) ui.metalnessValue.value = `${Math.round(Number(ui.metalness.value) * 100)}%`;
  if (ui.roughnessValue) ui.roughnessValue.value = `${Math.round(Number(ui.roughness.value) * 100)}%`;
  if (ui.shapeThresholdValue) ui.shapeThresholdValue.value = `${Math.round((Number(ui.shapeThreshold.value) / 255) * 100)}%`;
  if (ui.shapeNoiseAreaValue) ui.shapeNoiseAreaValue.value = `${Math.round(Number(ui.shapeNoiseArea.value))} px`;
  if (ui.shapeSmoothnessValue) ui.shapeSmoothnessValue.value = `${Math.round(Number(ui.shapeSmoothness.value))}%`;
  if (ui.shapeSimplifyValue) ui.shapeSimplifyValue.value = `${Math.round(Number(ui.shapeSimplify.value))}%`;
  if (ui.shapeBevelValue) ui.shapeBevelValue.value = `${Number(ui.shapeBevel.value).toFixed(1)} mm`;
}

/**
 * Captura los campos relevantes de un PointerEvent en un objeto plano.
 * Los PointerEvent del DOM son reciclados por el browser; si los almacenamos
 * directamente para procesarlos en el siguiente RAF, sus valores se invalidan.
 */
function capturePointerEvent(event) {
  return {
    clientX:     event.clientX,
    clientY:     event.clientY,
    shiftKey:    !!event.shiftKey,
    ctrlKey:     !!event.ctrlKey,
    metaKey:     !!event.metaKey,
    altKey:      !!event.altKey,
    buttons:     event.buttons,
    button:      event.button,
    pointerType: event.pointerType || 'mouse',
    pressure:    Number.isFinite(event.pressure) ? event.pressure : 1
  };
}

function getPointerPressure(event = null) {
  // Los mouse suelen reportar 0.5 mientras están presionados. Para no cambiar
  // la sensación actual en escritorio, solo usamos presión real en pen/touch.
  if (!event || event.pointerType === 'mouse') return 1;
  const p = Number(event.pressure);
  if (!Number.isFinite(p) || p <= 0) return 1;
  return THREE.MathUtils.clamp(p, 0.05, 1);
}

function scheduleBrushVisual(event) {
  pendingCursorEvent = capturePointerEvent(event);
}

function flushPendingStrokeEvents() {
  // Procesa el último pointermove pendiente antes de cerrar el trazo.
  // Sin esto, si el usuario suelta el click antes del siguiente RAF,
  // se pierde el tramo final de la brocha o de la pintura.
  if (pendingSculptEvent && state.tool === 'sculpt') {
    const ev = pendingSculptEvent;
    pendingSculptEvent = null;
    applySculptAtEvent(ev);
  }
  if (pendingPaintEvent && state.tool === 'paint') {
    const ev = pendingPaintEvent;
    pendingPaintEvent = null;
    applyPaintAtEvent(ev);
  }
}

function addHistoryEntry(entry, stack = state.undo) {
  addBudgetedHistoryEntry(state, entry, stack);
}

function clearHistoryStack(name) {
  clearBudgetedHistoryStack(state, name);
}

function trimUndoHistory() {
  trimBudgetedUndoHistory(state);
}

function matcapProfileFromViewMode(mode = state.viewMode) {
  if (mode === 'matcapGrey') return 'grey';
  if (mode === 'matcapRed') return 'red';
  return 'clay';
}

function ensureRecordMaterialState(record) {
  if (!record) return;
  if (!record.pbrMaterial) record.pbrMaterial = record.mesh.material;
  if (!(record.matcapMaterials instanceof Map)) record.matcapMaterials = new Map();
}

function getRecordMatcapMaterial(record, mode = state.viewMode) {
  ensureRecordMaterialState(record);
  const profile = matcapProfileFromViewMode(mode);
  if (!record.matcapMaterials.has(profile)) {
    const mat = createMatcapMaterial(profile);
    mat.name = `Matcap ${profile}`;
    record.matcapMaterials.set(profile, mat);
  }
  const matcap = record.matcapMaterials.get(profile);
  matcap.vertexColors = !!record.pbrMaterial?.vertexColors;
  matcap.side = record.pbrMaterial?.side ?? THREE.DoubleSide;
  matcap.needsUpdate = true;
  return matcap;
}

function applyViewMaterialToRecord(record) {
  ensureRecordMaterialState(record);
  if (state.viewMode === 'pbr') {
    record.mesh.material = record.pbrMaterial;
  } else {
    record.mesh.material = getRecordMatcapMaterial(record, state.viewMode);
  }
  record.mesh.material.wireframe = false;
  record.mesh.material.needsUpdate = true;
}

function applyViewModeToScene(mode = state.viewMode) {
  state.viewMode = mode || 'pbr';
  for (const rec of state.objects) applyViewMaterialToRecord(rec);
  if (state.selected) setTransformModeFromTool();
  renderObjectList();
  setStatus(state.viewMode === 'pbr' ? 'Vista PBR/textura real activada' : 'Vista Matcap activada para esculpir forma');
}

function getPbrMaterial(record) {
  ensureRecordMaterialState(record);
  return record.pbrMaterial;
}

function registerRecord(record) {
  ensureRecordMaterialState(record);
  state.recordsByMesh.set(record.mesh, record);
  state.recordsById.set(record.id, record);
  if (!state.raycastTargets.includes(record.mesh)) state.raycastTargets.push(record.mesh);
  applyViewMaterialToRecord(record);
  record.mesh.material.wireframe = false;
  if (state.wireframeEnabled) setRecordWireframe(record, true);
}

function unregisterRecord(record) {
  if (!record) return;
  state.recordsByMesh.delete(record.mesh);
  state.recordsById.delete(record.id);
  const rayIndex = state.raycastTargets.indexOf(record.mesh);
  if (rayIndex >= 0) state.raycastTargets.splice(rayIndex, 1);
  state.wireframeDirty.delete(record);
}

function markWireframeDirty(meshOrRecord) {
  if (!state.wireframeEnabled) return;
  const record = meshOrRecord?.mesh ? meshOrRecord : getRecord(meshOrRecord);
  if (record) state.wireframeDirty.add(record);
}

function flushWireframeUpdates() {
  if (!state.wireframeDirty.size) return;
  const dirty = Array.from(state.wireframeDirty);
  state.wireframeDirty.clear();
  for (const record of dirty) {
    if (state.objects.includes(record)) rebuildRecordWireframe(record, state.wireframeEnabled);
  }
}

/**
 * Recomputa normales, bounding box y bounding sphere para todos los meshes
 * modificados durante el frame actual. Se llama una vez por frame en animate()
 * en lugar de después de cada sello individual del trazo.
 *
 * Esto replica el patrón de SculptGL: las normales se actualizan al cierre
 * de cada frame de render, no en cada operación de escultura.
 */
function flushSculptDirtyMeshes() {
  if (!state.sculptDirtyMeshes.size) return;
  for (const mesh of state.sculptDirtyMeshes) {
    const geometry = mesh?.geometry;
    if (!geometry) continue;
    geometry.computeVertexNormals();
    smoothNormalsByWeldedGroups(geometry);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    rebuildCurrentSpatialIndexIfNeeded(geometry);
  }
  state.sculptDirtyMeshes.clear();
  // Actualiza las cajas de dimensión solo cuando hay cambios reales de geometría.
  if (state.selected) updateDimensionInputs();
}

function disposeRecord(record) {
  if (!record) return;
  disposeWireframeOverlay(record);
  scene.remove(record.mesh);
  unregisterRecord(record);
  record.mesh.geometry?.dispose?.();
  disposeRecordMaterials(record);
  disposeTextureSet(record.textureSet);
}

function prepareGeometry(geometry, { clone = true } = {}) {
  const incomingMask = geometry?.userData?.maskWeights instanceof Float32Array ? geometry.userData.maskWeights : null;
  if (clone) geometry = geometry.clone();
  if (incomingMask && incomingMask.length === geometry.getAttribute('position')?.count) {
    geometry.userData.maskWeights = new Float32Array(incomingMask);
  }
  // IMPORTANT: no convertimos a geometría no-indexada.
  // SculptGL trabaja con una malla/topología coherente; si duplicamos los vértices
  // por cara, cada triángulo se infla por separado y aparecen puntas o grietas.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  ensureMaskData(geometry);
  buildSculptTopology(geometry);
  smoothNormalsByWeldedGroups(geometry);
  // No conservamos una segunda copia completa de posiciones: el historial ya
  // almacena deltas/snapshots y duplicar el buffer consumía memoria sin uso.
  return geometry;
}

function getWeldedGroupId(keyToGroup, x, y, z) {
  const byY = keyToGroup.get(x);
  const byZ = byY?.get(y);
  return byZ?.get(z);
}

function setWeldedGroupId(keyToGroup, x, y, z, groupId) {
  let byY = keyToGroup.get(x);
  if (!byY) keyToGroup.set(x, byY = new Map());
  let byZ = byY.get(y);
  if (!byZ) byY.set(y, byZ = new Map());
  byZ.set(z, groupId);
}

function buildSculptTopology(geometry) {
  const position = geometry.getAttribute('position');
  if (!position) return null;

  const vertexToGroup = new Int32Array(position.count);
  const groups = [];
  // Evita crear una cadena `${x},${y},${z}` por vértice. Los niveles de Map
  // conservan claves numéricas exactas y no introducen colisiones de hash.
  const keyToGroup = new Map();

  for (let i = 0; i < position.count; i++) {
    const x = Math.round(position.getX(i) / SCULPT_WELD_EPSILON);
    const y = Math.round(position.getY(i) / SCULPT_WELD_EPSILON);
    const z = Math.round(position.getZ(i) / SCULPT_WELD_EPSILON);
    let groupId = getWeldedGroupId(keyToGroup, x, y, z);
    if (groupId === undefined) {
      groupId = groups.length;
      setWeldedGroupId(keyToGroup, x, y, z, groupId);
      groups.push({ vertices: [], neighbors: new Set(), triangles: new Set() });
    }
    vertexToGroup[i] = groupId;
    groups[groupId].vertices.push(i);
  }

  const addEdge = (a, b) => {
    const ga = vertexToGroup[a];
    const gb = vertexToGroup[b];
    if (ga === gb) return;
    groups[ga].neighbors.add(gb);
    groups[gb].neighbors.add(ga);
  };

  const addTriangle = (tri, a, b, c) => {
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
    groups[vertexToGroup[a]]?.triangles.add(tri);
    groups[vertexToGroup[b]]?.triangles.add(tri);
    groups[vertexToGroup[c]]?.triangles.add(tri);
  };

  const index = geometry.getIndex();
  if (index) {
    const arr = index.array;
    for (let i = 0, tri = 0; i < arr.length; i += 3, tri++) {
      addTriangle(tri, arr[i], arr[i + 1], arr[i + 2]);
    }
  } else {
    for (let i = 0, tri = 0; i < position.count; i += 3, tri++) {
      addTriangle(tri, i, i + 1, i + 2);
    }
  }

  const compactGroups = groups.map((group) => ({
    vertices: group.vertices,
    neighbors: Array.from(group.neighbors),
    triangles: Array.from(group.triangles)
  }));

  geometry.userData.sculptTopology = {
    vertexToGroup,
    groups: compactGroups,
    vertexCount: position.count,
    hasIndex: !!index,
    spatialIndex: null,
    spatialQueryResult: [],
    spatialNeedsRebuild: false
  };
  return geometry.userData.sculptTopology;
}

function smoothNormalsByWeldedGroups(geometry) {
  const normal = geometry.getAttribute('normal');
  const topology = geometry.userData.sculptTopology;
  if (!normal || !topology?.groups) return;

  // SphereGeometry y muchas mallas importadas duplican vértices en la costura UV.
  // Aunque esas posiciones estén soldadas para esculpir, computeVertexNormals()
  // calcula normales separadas porque la topología real está partida por la UV.
  // Promediamos las normales de cada grupo soldado y las copiamos a sus duplicados
  // para que la iluminación no revele una línea vertical.
  const averaged = new THREE.Vector3();
  for (const group of topology.groups) {
    averaged.set(0, 0, 0);
    for (const vertexIndex of group.vertices) {
      averaged.x += normal.getX(vertexIndex);
      averaged.y += normal.getY(vertexIndex);
      averaged.z += normal.getZ(vertexIndex);
    }
    if (averaged.lengthSq() === 0) continue;
    averaged.normalize();
    for (const vertexIndex of group.vertices) {
      normal.setXYZ(vertexIndex, averaged.x, averaged.y, averaged.z);
    }
  }
  normal.needsUpdate = true;
}

function getSculptTopology(geometry) {
  const position = geometry.getAttribute('position');
  const topo = geometry.userData.sculptTopology;
  if (!topo || topo.vertexCount !== position.count || topo.hasIndex !== !!geometry.getIndex()) {
    return buildSculptTopology(geometry);
  }
  return topo;
}


function groupLocalPositionFromSource(position, group, target, sourceArray = null) {
  if (sourceArray) return getGroupLocalPositionFromArray(sourceArray, group, target);
  return getGroupLocalPosition(position, group, target);
}

function createSpatialBuckets() {
  const byX = new Map();
  return {
    get(x, y, z) {
      return byX.get(x)?.get(y)?.get(z);
    },
    set(x, y, z, value) {
      let byY = byX.get(x);
      if (!byY) byX.set(x, byY = new Map());
      let byZ = byY.get(y);
      if (!byZ) byY.set(y, byZ = new Map());
      byZ.set(z, value);
    },
    delete(x, y, z) {
      const byY = byX.get(x);
      const byZ = byY?.get(y);
      if (!byZ) return;
      byZ.delete(z);
      if (!byZ.size) byY.delete(y);
      if (!byY.size) byX.delete(x);
    }
  };
}

function buildSculptSpatialIndex(geometry, topology, sourceArray = null) {
  const position = geometry.getAttribute('position');
  const groups = topology.groups || [];
  const centers = new Float32Array(groups.length * 3);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (let groupId = 0; groupId < groups.length; groupId++) {
    const group = groups[groupId];
    groupLocalPositionFromSource(position, group, tmpLocal, sourceArray);
    const offset = groupId * 3;
    centers[offset] = tmpLocal.x;
    centers[offset + 1] = tmpLocal.y;
    centers[offset + 2] = tmpLocal.z;
    min.min(tmpLocal);
    max.max(tmpLocal);
  }

  const size = tmpV.copy(max).sub(min);
  const diagonal = Math.max(size.length(), 1e-4);
  const cellSize = Math.max(diagonal / 42, 1e-5);
  const buckets = createSpatialBuckets();
  const groupCells = new Int32Array(groups.length * 3);

  for (let groupId = 0; groupId < groups.length; groupId++) {
    const offset = groupId * 3;
    const cx = Math.floor(centers[offset] / cellSize);
    const cy = Math.floor(centers[offset + 1] / cellSize);
    const cz = Math.floor(centers[offset + 2] / cellSize);
    groupCells[offset] = cx;
    groupCells[offset + 1] = cy;
    groupCells[offset + 2] = cz;
    let bucket = buckets.get(cx, cy, cz);
    if (!bucket) buckets.set(cx, cy, cz, bucket = []);
    bucket.push(groupId);
  }

  return { centers, buckets, groupCells, cellSize, groupCount: groups.length };
}

function getCurrentSpatialIndex(geometry, topology) {
  if (!topology.spatialIndex || topology.spatialIndex.groupCount !== topology.groups.length) {
    topology.spatialIndex = buildSculptSpatialIndex(geometry, topology);
    topology.spatialNeedsRebuild = false;
  }
  return topology.spatialIndex;
}

function rebuildCurrentSpatialIndexIfNeeded(geometry) {
  const topology = geometry?.userData?.sculptTopology;
  if (!topology?.groups || !topology.spatialNeedsRebuild) return;
  topology.spatialIndex = buildSculptSpatialIndex(geometry, topology);
  topology.spatialNeedsRebuild = false;
}

function getProxySpatialIndex(geometry, topology) {
  if (!state.strokeProxyPositions) return null;
  if (!state.strokeProxySpatialIndex || state.strokeProxySpatialSource !== state.strokeProxyPositions) {
    state.strokeProxySpatialSource = state.strokeProxyPositions;
    state.strokeProxySpatialIndex = buildSculptSpatialIndex(geometry, topology, state.strokeProxyPositions);
  }
  return state.strokeProxySpatialIndex;
}

function markSpatialIndexStale(geometry) {
  const topology = geometry?.userData?.sculptTopology;
  if (topology?.groups) topology.spatialNeedsRebuild = true;
}


function updateSpatialIndexGroups(geometry, topology, changedGroups) {
  if (!geometry || !topology?.groups || !changedGroups?.length) return;
  const index = topology.spatialIndex;
  if (!index || topology.spatialNeedsRebuild || index.groupCount !== topology.groups.length) {
    topology.spatialNeedsRebuild = true;
    return;
  }

  const position = geometry.getAttribute('position');
  const seen = new Set();
  for (const item of changedGroups) {
    const groupId = typeof item === 'number' ? item : item.groupId;
    if (!Number.isInteger(groupId) || seen.has(groupId)) continue;
    seen.add(groupId);
    const group = topology.groups[groupId];
    if (!group) continue;

    getGroupLocalPosition(position, group, tmpLocal);
    const offset = groupId * 3;
    index.centers[offset] = tmpLocal.x;
    index.centers[offset + 1] = tmpLocal.y;
    index.centers[offset + 2] = tmpLocal.z;

    const cx = Math.floor(tmpLocal.x / index.cellSize);
    const cy = Math.floor(tmpLocal.y / index.cellSize);
    const cz = Math.floor(tmpLocal.z / index.cellSize);
    const previousOffset = groupId * 3;
    const px = index.groupCells[previousOffset];
    const py = index.groupCells[previousOffset + 1];
    const pz = index.groupCells[previousOffset + 2];
    if (cx === px && cy === py && cz === pz) continue;

    const previousBucket = index.buckets.get(px, py, pz);
    if (previousBucket) {
      const i = previousBucket.indexOf(groupId);
      if (i >= 0) previousBucket.splice(i, 1);
      if (!previousBucket.length) index.buckets.delete(px, py, pz);
    }
    let nextBucket = index.buckets.get(cx, cy, cz);
    if (!nextBucket) index.buckets.set(cx, cy, cz, nextBucket = []);
    nextBucket.push(groupId);
    index.groupCells[previousOffset] = cx;
    index.groupCells[previousOffset + 1] = cy;
    index.groupCells[previousOffset + 2] = cz;
  }
}

function worldRadiusToSafeLocalRadius(mesh, radius) {
  mesh.matrixWorld.decompose(tmpV, tmpQ, tmpScale);
  const minScale = Math.max(1e-6, Math.min(Math.abs(tmpScale.x), Math.abs(tmpScale.y), Math.abs(tmpScale.z)));
  return radius / minScale;
}

function querySpatialIndex(index, localPoint, localRadius, target = []) {
  target.length = 0;
  if (!index || !index.cellSize) return target;
  const cellSize = index.cellSize;
  const minX = Math.floor((localPoint.x - localRadius) / cellSize);
  const maxX = Math.floor((localPoint.x + localRadius) / cellSize);
  const minY = Math.floor((localPoint.y - localRadius) / cellSize);
  const maxY = Math.floor((localPoint.y + localRadius) / cellSize);
  const minZ = Math.floor((localPoint.z - localRadius) / cellSize);
  const maxZ = Math.floor((localPoint.z + localRadius) / cellSize);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        const bucket = index.buckets.get(x, y, z);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) target.push(bucket[i]);
      }
    }
  }
  return target;
}

function ensureMaskData(geometry) {
  const position = geometry.getAttribute('position');
  if (!position) return null;
  let needsColorSync = false;
  if (!geometry.userData.maskWeights || geometry.userData.maskWeights.length !== position.count) {
    geometry.userData.maskWeights = new Float32Array(position.count).fill(1);
    needsColorSync = true;
  }
  if (!geometry.getAttribute('color') || geometry.getAttribute('color').count !== position.count) {
    const colors = new Float32Array(position.count * 3);
    colors.fill(1);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    needsColorSync = true;
  }
  // Antes se reescribían todos los colores en cada sello del pincel, aunque la
  // máscara no cambiara. En mallas densas esto era uno de los mayores costos.
  if (needsColorSync) updateMaskColors(geometry);
  return geometry.userData.maskWeights;
}

function getGroupMask(geometry, group) {
  const mask = ensureMaskData(geometry);
  let sum = 0;
  for (const vertexIndex of group.vertices) sum += mask[vertexIndex];
  return sum / Math.max(1, group.vertices.length);
}

function setGroupMask(geometry, group, value) {
  const mask = ensureMaskData(geometry);
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  for (const vertexIndex of group.vertices) mask[vertexIndex] = clamped;
}

function updateMaskColors(geometry, groups = null) {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const mask = geometry.userData.maskWeights;
  if (!position || !color || !mask) return;

  const writeVertex = (i) => {
    const m = THREE.MathUtils.clamp(mask[i], 0, 1);
    // m=1 no altera el material; m=0 marca la zona protegida con tono frío/oscuro.
    color.setXYZ(i, 0.36 + 0.64 * m, 0.48 + 0.52 * m, 0.72 + 0.28 * m);
  };

  if (groups?.length) {
    for (const group of groups) {
      for (const vertexIndex of group.vertices) writeVertex(vertexIndex);
    }
  } else {
    for (let i = 0; i < position.count; i++) writeVertex(i);
  }
  color.needsUpdate = true;
}

function getGroupLocalPosition(position, group, target = new THREE.Vector3()) {
  return target.fromBufferAttribute(position, group.vertices[0]);
}

function getGroupLocalPositionFromArray(array, group, target = new THREE.Vector3()) {
  const vertexIndex = group.vertices[0] * 3;
  return target.set(array[vertexIndex], array[vertexIndex + 1], array[vertexIndex + 2]);
}

function setGroupLocalPosition(position, group, localPosition) {
  for (const vertexIndex of group.vertices) {
    position.setXYZ(vertexIndex, localPosition.x, localPosition.y, localPosition.z);
  }
}

function getGroupWorldNormal(normalAttr, group, normalMatrix, target = new THREE.Vector3()) {
  target.set(0, 0, 0);
  for (const vertexIndex of group.vertices) {
    tmpV.fromBufferAttribute(normalAttr, vertexIndex).applyNormalMatrix(normalMatrix);
    if (tmpV.lengthSq() > 0) target.add(tmpV.normalize());
  }
  if (target.lengthSq() === 0) target.set(0, 1, 0);
  return target.normalize();
}

function sculptFalloff(distance01) {
  const d = Math.min(1, Math.max(0, distance01));
  // Misma familia de caída usada por SculptGL: 1 - 4d³ + 3d⁴.
  // Tiene borde suave y evita escalones duros en el límite del pincel.
  return 1 - 4 * d * d * d + 3 * d * d * d * d;
}

function primitiveGeometry(type) {
  switch (type) {
    case 'box': return new THREE.BoxGeometry(1, 1, 1, 36, 36, 36);
    case 'sphere': return new THREE.SphereGeometry(0.55, 160, 112);
    case 'cylinder': return new THREE.CylinderGeometry(0.45, 0.45, 1.1, 96, 48, false);
    case 'cone': return new THREE.ConeGeometry(0.55, 1.2, 96, 48, false);
    case 'torus': return new THREE.TorusGeometry(0.42, 0.16, 48, 128);
    case 'plane': return new THREE.PlaneGeometry(1.6, 1.6, 80, 80);
    default: return new THREE.BoxGeometry(1, 1, 1, 36, 36, 36);
  }
}

function addPrimitive(type = 'sphere', options = {}) {
  const textureSet = makeTextureCanvas(ui.baseColor.value);
  const geometry = prepareGeometry(primitiveGeometry(type));
  const mesh = new THREE.Mesh(geometry, createMaterial(textureSet));
  const primitiveNames = { box: 'Cubo', sphere: 'Esfera', cylinder: 'Cilindro', cone: 'Cono', torus: 'Toro', plane: 'Plano' };
  mesh.name = `${primitiveNames[type] || 'Objeto'} ${state.idCounter}`;
  mesh.castShadow = true;
  // No recibe su propia sombra: así la superficie queda visualmente lisa, sin bandas.
  mesh.receiveShadow = false;
  // Tinkercad coloca las piezas sobre el plano de trabajo. Antes la esfera
  // quedaba centrada en y=0 y podía verse parcialmente hundida o perderse
  // visualmente contra la grilla. Ahora cualquier primitiva aparece completa
  // sobre el plano y la cámara la encuadra después de que el layout existe.
  geometry.computeBoundingBox();
  if (type === 'plane') {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.004;
  } else if (geometry.boundingBox) {
    mesh.position.y = -geometry.boundingBox.min.y;
  }
  const record = {
    id: state.idCounter++,
    type,
    mesh,
    textureSet,
    pbrMaterial: mesh.material,
    matcapMaterials: new Map(),
    createdAt: Date.now()
  };
  mesh.userData.recordId = record.id;
  scene.add(mesh);
  state.objects.push(record);
  registerRecord(record);
  selectObject(mesh);
  if (options.autoFrame !== false) frameSelection();
  renderObjectList();
  if (!options.skipHistory) pushObjectsAdded('Agregar objeto', [record]);
  setStatus(`Objeto agregado: ${mesh.name}`);
}

function getRecord(mesh = state.selected) {
  if (!mesh) return null;
  return state.recordsByMesh.get(mesh) || state.recordsById.get(mesh.userData?.recordId) || null;
}

function isTransformTool(tool = state.tool) {
  return ['select', 'move', 'rotate', 'scale'].includes(tool);
}

function selectObject(mesh) {
  state.selected = mesh || null;
  setTransformModeFromTool();
  updateInspector();
  renderObjectList();
}

function setTransformModeFromTool() {
  const transformActive = !!state.selected && isTransformTool();

  // Bug fix: TransformControls must be fully disabled/detached while sculpting,
  // painting or measuring. Hiding the gizmo with visible=false is not enough:
  // the control can still receive pointer events and translate the whole mesh
  // when the user keeps the left mouse button pressed.
  transform.enabled = transformActive;
  transform.visible = transformActive;

  if (!transformActive) {
    transform.detach();
    return;
  }

  transform.attach(state.selected);
  transform.setSpace('world');
  if (state.tool === 'move') transform.setMode('translate');
  else if (state.tool === 'rotate') transform.setMode('rotate');
  else if (state.tool === 'scale') transform.setMode('scale');
  else transform.setMode('translate');
}

function setTool(tool, { syncWorkspace = true } = {}) {
  state.tool = TOOL_META[tool] ? tool : 'select';
  document.querySelectorAll('.tool').forEach((btn) => {
    const active = btn.dataset.tool === state.tool;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  if (syncWorkspace) setWorkspace(TOOL_META[state.tool].workspace, { syncTool: false, scroll: false });
  setTransformModeFromTool();
  brushRing.visible = false;
  brushDot.visible = false;
  brushPreview.style.display = 'none';
  const cursor = state.tool === 'paint' ? 'crosshair' : state.tool === 'sculpt' ? 'none' : 'default';
  canvas.style.cursor = cursor;
  updateContextUI();
  setStatus(`Herramienta: ${TOOL_META[state.tool].label}`);
}

function setInspectorCollapsed(collapsed) {
  document.body.classList.toggle('inspector-collapsed', collapsed);
  if (ui.inspectorToggle) {
    ui.inspectorToggle.textContent = collapsed ? 'Mostrar panel' : 'Ocultar panel';
    ui.inspectorToggle.title = collapsed ? 'Mostrar panel derecho' : 'Ocultar panel derecho';
    ui.inspectorToggle.setAttribute('aria-expanded', String(!collapsed));
  }

  // El panel derecho se oculta con una transición CSS. Si solo redimensionamos
  // el renderer en el primer frame, el canvas termina escalándose por CSS y la
  // cámara conserva el aspect ratio anterior: la esfera se ve ancha o angosta.
  // Por eso forzamos varios reajustes durante y al final de la transición.
  scheduleViewportResize();
}

function updateInspector() {
  const mesh = state.selected;
  const enabled = !!mesh;
  ['objectName','dimX','dimY','dimZ','duplicateBtn','deleteBtn','centerObjectBtn','focusBtn','focusQuickBtn','saveTextureBtn','saveTexturePanelBtn','subdivideMeshBtn','softRemeshBtn','reduceMeshBtn','relaxMeshBtn','clearMaskBtn','invertMaskBtn','blurMaskBtn','clearTextureBtn','exportStlSelectedBtn'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !enabled;
  });
  if (ui.selectionSummary) ui.selectionSummary.textContent = mesh?.name || 'Sin objeto';
  if (!mesh) {
    ui.objectName.value = '';
    ui.dimX.value = ui.dimY.value = ui.dimZ.value = '';
    updateMeshStats();
    return;
  }
  ui.objectName.value = mesh.name;
  const rec = getRecord(mesh);
  if (rec) {
    ui.baseColor.value = sampleCanvasBaseColor(rec.textureSet.canvas);
    const pbr = getPbrMaterial(rec);
    ui.metalness.value = pbr.metalness;
    ui.roughness.value = pbr.roughness;
  }
  updateDimensionInputs();
  updateRangeOutputs();
  updateMeshStats();
}

function getLocalSize(mesh = state.selected) {
  if (!mesh) return new THREE.Vector3();
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);
  size.multiply(mesh.scale);
  return size;
}

const countFormatter = new Intl.NumberFormat('es-PE');
function formatCount(value) {
  return countFormatter.format(value || 0);
}

function updateMeshStats(mesh = state.selected) {
  if (!ui.meshStats) return;
  if (!mesh?.geometry) {
    ui.meshStats.textContent = 'Sin objeto seleccionado';
    if (ui.meshQuality) {
      ui.meshQuality.className = 'quality-hint';
      ui.meshQuality.textContent = 'Selecciona un objeto para evaluar su malla.';
    }
    return;
  }
  const stats = geometryStats(mesh.geometry);
  const projectedSubdivideTriangles = stats.triangles * 4;
  ui.meshStats.textContent = `${formatCount(stats.vertices)} vértices · ${formatCount(stats.triangles)} triángulos · más detalle → ${formatCount(projectedSubdivideTriangles)} triángulos`;
  if (!ui.meshQuality) return;
  ui.meshQuality.className = 'quality-hint';
  if (stats.triangles < 4500) {
    ui.meshQuality.classList.add('warn');
    ui.meshQuality.textContent = 'Malla ligera: adecuada para formas amplias. Usa “Más detalle” antes de crear pliegues finos.';
  } else if (stats.triangles <= 120000) {
    ui.meshQuality.classList.add('good');
    ui.meshQuality.textContent = 'Densidad equilibrada: buena respuesta y suficiente detalle para la mayoría de pinceles.';
  } else if (stats.triangles <= 260000) {
    ui.meshQuality.classList.add('warn');
    ui.meshQuality.textContent = 'Malla densa: conserva detalle, pero puede reducir la fluidez en equipos modestos.';
  } else {
    ui.meshQuality.classList.add('danger');
    ui.meshQuality.textContent = 'Malla muy pesada: usa “Aligerar” antes de continuar esculpiendo.';
  }
}

function geometryWarningMessage(label, before, after) {
  return `${label}

Antes: ${formatCount(before.vertices)} vértices / ${formatCount(before.triangles)} triángulos.
Después aprox.: ${formatCount(after.vertices)} vértices / ${formatCount(after.triangles)} triángulos.

Esta operación puede aumentar el peso del modelo y el consumo de memoria. ¿Continuar?`;
}

function confirmMeshOperation(label, before, after, force = false) {
  const heavy = force || after.vertices > 140000 || after.triangles > 260000;
  if (!heavy) return true;
  return window.confirm(geometryWarningMessage(label, before, after));
}

function replaceSelectedGeometry(newGeometry, label) {
  const rec = getRecord();
  if (!rec || !newGeometry) return;
  pushObjectHistory(label, rec.mesh);
  const oldGeometry = rec.mesh.geometry;
  disposeWireframeOverlay(rec);
  rec.mesh.geometry = prepareGeometry(newGeometry);
  oldGeometry?.dispose?.();
  newGeometry.dispose?.();
  rec.mesh.geometry.computeBoundingBox();
  rec.mesh.geometry.computeBoundingSphere();
  markWireframeDirty(rec);
  setRecordWireframe(rec, state.wireframeEnabled);
  updateInspector();
  renderObjectList();
  updateHistoryButtons();
  setStatus(`${label}: topología actualizada`);
}


function shouldUseDynamicTopology(mode) {
  if (!ui.dynamicTopology?.checked) return false;
  if (state.meshWorkerBusy) return false;
  // Move/Drag/Twist dependen de proxies/continuidad del trazo; cambiar la
  // topología debajo de ellos vuelve inestable el desplazamiento. La primera
  // versión dinámica se limita a herramientas de volumen/detalle.
  return ['brush', 'inflate', 'deflate', 'pinch', 'crease', 'flatten', 'smooth', 'noise', 'localScale'].includes(mode);
}

function applyDynamicTopologyIfNeeded(mesh, hit, radius, mode) {
  if (!shouldUseDynamicTopology(mode)) return false;
  const rec = getRecord(mesh);
  if (!rec) return false;
  const before = geometryStats(mesh.geometry);
  if (before.triangles > 360000) {
    setStatus('Dynamic topology pausado: malla demasiado pesada. Usa Reducir malla o Remesh suave.');
    return false;
  }

  mesh.updateMatrixWorld(true);
  const invWorld = tmpM.copy(mesh.matrixWorld).invert();
  const localPoint = tmpLocal.copy(hit.point).applyMatrix4(invWorld).clone();
  const localRadius = worldRadiusToSafeLocalRadius(mesh, radius);
  const detail = THREE.MathUtils.clamp(parseFloat(ui.dynamicTopoEdge?.value || '0.30'), 0.12, 0.8);
  const maxEdgeLength = Math.max(localRadius * detail, 0.0035);
  const maxTriangles = before.triangles > 180000 ? 320 : before.triangles > 90000 ? 520 : 900;

  const topology = getSculptTopology(mesh.geometry);
  const spatialIndex = getCurrentSpatialIndex(mesh.geometry, topology);
  const nearbyGroups = querySpatialIndex(
    spatialIndex,
    localPoint,
    localRadius * 1.35,
    topology.spatialQueryResult
  );
  const candidateSet = new Set();
  for (const groupId of nearbyGroups) {
    for (const tri of topology.groups[groupId]?.triangles || []) candidateSet.add(tri);
  }

  const result = localSubdivideGeometry(mesh.geometry, {
    center: localPoint,
    radius: localRadius * 1.08,
    maxEdgeLength,
    maxTriangles,
    boundaryExpansion: 1,
    candidateTriangles: Array.from(candidateSet)
  });

  if (!result.changed) {
    result.geometry?.dispose?.();
    return false;
  }

  const oldGeometry = mesh.geometry;
  disposeWireframeOverlay(rec);
  // result.geometry es nueva y todavía no tiene normales/topología. La
  // preparamos in-place para evitar otra clonación completa del buffer.
  mesh.geometry = prepareGeometry(result.geometry, { clone: false });
  oldGeometry?.dispose?.();

  // Si el trazo usa proxy de posiciones, la cantidad de vértices acaba de
  // cambiar. Reiniciamos el proxy con la nueva malla para evitar lecturas fuera
  // de rango durante este mismo trazo.
  if (state.strokeProxyObject === mesh) {
    state.strokeProxyPositions = new Float32Array(mesh.geometry.getAttribute('position').array);
    state.strokeProxySpatialIndex = null;
    state.strokeProxySpatialSource = null;
  }

  markSpatialIndexStale(mesh.geometry);
  state.sculptDirtyMeshes.add(mesh);
  markWireframeDirty(mesh);
  updateMeshStats(mesh);
  setStatus(`Dynamic topology: +${formatCount(result.addedTriangles ?? result.splitTriangles * 3)} triángulos locales`);
  return true;
}

function getMeshWorker() {
  if (meshWorker) return meshWorker;
  meshWorker = new Worker(new URL('./workers/meshWorker.js', import.meta.url), { type: 'module' });
  meshWorker.onmessage = (event) => {
    const { id, ok, result, error } = event.data || {};
    const job = meshWorkerJobs.get(id);
    if (!job) return;
    meshWorkerJobs.delete(id);
    if (ok) job.resolve(result);
    else job.reject(new Error(error || 'Error desconocido en worker de malla'));
  };
  meshWorker.onerror = (error) => {
    for (const [, job] of meshWorkerJobs) job.reject(error instanceof Error ? error : new Error(error.message || 'Error en worker de malla'));
    meshWorkerJobs.clear();
    meshWorker?.terminate?.();
    meshWorker = null;
  };
  return meshWorker;
}

function geometryToWorkerPayload(geometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  ensureMaskData(geometry);
  return {
    positions: new Float32Array(pos.array),
    uvs: uv ? new Float32Array(uv.array) : null,
    masks: geometry.userData.maskWeights ? new Float32Array(geometry.userData.maskWeights) : null,
    index: index ? new Uint32Array(index.array) : null
  };
}

function transferListForPayload(payload) {
  return [payload.positions, payload.uvs, payload.masks, payload.index]
    .filter(Boolean)
    .map((typed) => typed.buffer);
}

function workerResultToGeometry(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  if (data.uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  if (data.index) setIndexAttribute(geometry, data.index);
  if (data.masks && data.masks.length === data.positions.length / 3) geometry.userData.maskWeights = data.masks;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function setMeshOperationBusy(isBusy, label = 'Procesando malla') {
  state.meshWorkerBusy = isBusy;
  [ui.subdivideMeshBtn, ui.softRemeshBtn, ui.reduceMeshBtn, ui.relaxMeshBtn].forEach((button) => {
    if (button) button.disabled = isBusy;
  });
  if (isBusy) setStatus(`${label}… la interfaz sigue activa`);
}

function runMeshWorkerOperation(operation, geometry, options = {}) {
  const id = meshWorkerSeq++;
  const payload = geometryToWorkerPayload(geometry);
  const worker = getMeshWorker();
  return new Promise((resolve, reject) => {
    meshWorkerJobs.set(id, { resolve, reject });
    worker.postMessage({ id, op: operation, geometry: payload, options }, transferListForPayload(payload));
  }).then(workerResultToGeometry);
}

async function subdivideSelectedMesh() {
  const rec = getRecord();
  if (!rec || state.meshWorkerBusy) return;
  const before = geometryStats(rec.mesh.geometry);
  const after = { vertices: before.vertices * 2, triangles: before.triangles * 4 };
  if (!confirmMeshOperation('Subdividir malla', before, after, before.triangles > 55000)) return;
  try {
    setMeshOperationBusy(true, 'Subdividiendo malla en worker');
    const next = await runMeshWorkerOperation('subdivide', rec.mesh.geometry);
    replaceSelectedGeometry(next, 'Subdividir malla');
  } catch (err) {
    console.error(err);
    setStatus('No se pudo subdividir la malla. Revisa la consola.');
  } finally {
    setMeshOperationBusy(false);
  }
}

async function softRemeshSelectedMesh() {
  const rec = getRecord();
  if (!rec || state.meshWorkerBusy) return;
  const before = geometryStats(rec.mesh.geometry);
  const shouldSubdivide = before.triangles < 90000;
  const after = shouldSubdivide
    ? { vertices: before.vertices * 2, triangles: before.triangles * 4 }
    : { vertices: before.vertices, triangles: before.triangles };
  if (!confirmMeshOperation('Remesh suave', before, after, true)) return;
  try {
    setMeshOperationBusy(true, 'Remesh suave en worker');
    const next = await runMeshWorkerOperation('softRemesh', rec.mesh.geometry, { subdivide: shouldSubdivide, relaxIterations: shouldSubdivide ? 5 : 7 });
    replaceSelectedGeometry(next, 'Remesh suave');
  } catch (err) {
    console.error(err);
    setStatus('No se pudo remeshear esta malla. Revisa la consola.');
  } finally {
    setMeshOperationBusy(false);
  }
}

async function relaxSelectedMesh() {
  const rec = getRecord();
  if (!rec || state.meshWorkerBusy) return;
  const before = geometryStats(rec.mesh.geometry);
  if (!confirmMeshOperation('Relajar malla', before, before, before.vertices > 140000)) return;
  try {
    setMeshOperationBusy(true, 'Relajando malla en worker');
    const next = await runMeshWorkerOperation('relax', rec.mesh.geometry, { iterations: 6 });
    replaceSelectedGeometry(next, 'Relajar malla');
  } catch (err) {
    console.error(err);
    setStatus('No se pudo relajar esta malla. Revisa la consola.');
  } finally {
    setMeshOperationBusy(false);
  }
}

async function reduceSelectedMesh() {
  const rec = getRecord();
  if (!rec || state.meshWorkerBusy) return;
  const before = geometryStats(rec.mesh.geometry);
  if (before.vertices < 80) {
    setStatus('La malla ya es demasiado ligera para reducirla.');
    return;
  }
  const after = { vertices: Math.max(12, Math.floor(before.vertices * 0.65)), triangles: Math.max(12, Math.floor(before.triangles * 0.65)) };
  if (!confirmMeshOperation('Reducir malla', before, after, true)) return;
  try {
    setMeshOperationBusy(true, 'Reduciendo malla en worker');
    const next = await runMeshWorkerOperation('reduce', rec.mesh.geometry, { targetFraction: 0.65 });
    replaceSelectedGeometry(next, 'Reducir malla');
  } catch (err) {
    console.error(err);
    setStatus('No se pudo reducir esta malla. Prueba primero con Remesh suave.');
  } finally {
    setMeshOperationBusy(false);
  }
}

function updateDimensionInputs() {
  if (!state.selected) return;
  const size = getLocalSize(state.selected);
  ui.dimX.value = size.x.toFixed(2);
  ui.dimY.value = size.y.toFixed(2);
  ui.dimZ.value = size.z.toFixed(2);
}

function applyDimensions(axisChanged = null) {
  const mesh = state.selected;
  if (!mesh) return;
  pushObjectHistory('Cambiar dimensiones');
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  const base = new THREE.Vector3();
  box.getSize(base);
  const current = getLocalSize(mesh);
  let target = new THREE.Vector3(
    Math.max(0.01, parseFloat(ui.dimX.value) || current.x),
    Math.max(0.01, parseFloat(ui.dimY.value) || current.y),
    Math.max(0.01, parseFloat(ui.dimZ.value) || current.z)
  );
  if (ui.lockAspect.checked && axisChanged) {
    const ratio = target[axisChanged] / current[axisChanged];
    target = current.clone().multiplyScalar(ratio);
    ui.dimX.value = target.x.toFixed(2);
    ui.dimY.value = target.y.toFixed(2);
    ui.dimZ.value = target.z.toFixed(2);
  }
  mesh.scale.set(
    target.x / Math.max(base.x, 0.0001),
    target.y / Math.max(base.y, 0.0001),
    target.z / Math.max(base.z, 0.0001)
  );
  applySnapping();
  renderObjectList();
}

function axisMaskFromTransformAxis(axis) {
  if (!axis || axis === 'XYZ' || axis === 'XYZE') return { x: true, y: true, z: true };
  return {
    x: axis.includes('X'),
    y: axis.includes('Y'),
    z: axis.includes('Z')
  };
}

function constrainTransformToActiveAxes() {
  const mesh = state.selected;
  if (!mesh || !transform.dragging || !state.transformDragStart) return;
  if (!transform.getMode || transform.getMode() !== 'translate') return;
  const axis = transform.axis || state.transformDragAxis;
  if (!axis) return;
  const mask = axisMaskFromTransformAxis(axis);

  // Cuando se arrastra una flecha del gizmo, los otros ejes deben quedar
  // bloqueados. Sin esto, el snap de grilla y pequeñas variaciones de cámara
  // podían hacer que el objeto pareciera salirse del eje elegido.
  if (!mask.x) mesh.position.x = state.transformDragStart.x;
  if (!mask.y) mesh.position.y = state.transformDragStart.y;
  if (!mask.z) mesh.position.z = state.transformDragStart.z;
}

function applySnapping(axis = null) {
  const mesh = state.selected;
  if (!mesh || !ui.snapGrid.checked) return;
  const g = Math.max(0.01, parseFloat(ui.gridSize.value) || 0.25);
  const mask = axisMaskFromTransformAxis(axis);
  if (mask.x) mesh.position.x = Math.round(mesh.position.x / g) * g;
  if (mask.y) mesh.position.y = Math.round(mesh.position.y / g) * g;
  if (mask.z) mesh.position.z = Math.round(mesh.position.z / g) * g;
}

function renderObjectList() {
  ui.objectList.replaceChildren();
  for (const rec of state.objects) {
    const item = document.createElement('div');
    item.className = 'object-item' + (rec.mesh === state.selected ? ' active' : '');
    const name = document.createElement('strong');
    name.textContent = rec.mesh.name;
    const size = getLocalSize(rec.mesh);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}`;
    const eye = document.createElement('button');
    eye.className = 'object-eye';
    eye.type = 'button';
    eye.title = rec.mesh.visible ? 'Ocultar objeto' : 'Mostrar objeto';
    eye.textContent = rec.mesh.visible ? '◉' : '○';
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      pushObjectHistory('Cambiar visibilidad', rec.mesh);
      rec.mesh.visible = !rec.mesh.visible;
      setRecordWireframe(rec, state.wireframeEnabled);
      if (!rec.mesh.visible && state.selected === rec.mesh) setTransformModeFromTool();
      renderObjectList();
    });
    item.addEventListener('click', () => selectObject(rec.mesh));
    item.append(name, badge, eye);
    ui.objectList.appendChild(item);
  }
}

function setPointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function getViewportHeightPx() {
  const rect = canvas.getBoundingClientRect();
  return Math.max(1, rect.height || renderer.domElement.clientHeight || window.innerHeight);
}

function getWorldUnitsPerPixelAt(point) {
  const distance = Math.max(0.001, camera.position.distanceTo(point));
  if (camera.isPerspectiveCamera) {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    return (2 * Math.tan(fov * 0.5) * distance) / getViewportHeightPx();
  }
  if (camera.isOrthographicCamera) {
    return (camera.top - camera.bottom) / getViewportHeightPx();
  }
  return 0.01;
}

function getSculptScreenRadiusPx() {
  return Math.max(MIN_SCULPT_RADIUS_PX, parseFloat(ui.brushRadius.value) * SCULPT_RADIUS_TO_SCREEN_PX);
}

function screenRadiusToWorldRadius(point, screenRadiusPx) {
  return Math.max(0.001, screenRadiusPx * getWorldUnitsPerPixelAt(point));
}

function getSculptWorldRadius(hitOrPoint) {
  const point = hitOrPoint?.point || hitOrPoint;
  return screenRadiusToWorldRadius(point, getSculptScreenRadiusPx());
}

function intersectObjects(event, objects = state.raycastTargets) {
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  // Los objetos de escena ya son meshes raíz; evitamos crear un array nuevo y
  // recorrer descendientes en cada pointermove.
  const hits = raycaster.intersectObjects(objects, false);
  return hits[0] || null;
}

function onPointerDown(event) {
  if (transform.dragging) return;

  // Botón derecho: reservado para orbitar con OrbitControls.
  if (event.button === 2) return;
  // En mouse, solo el botón izquierdo aplica herramientas.
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  state.isPointerDown = true;
  state.lastSculptHit = null;
  state.lastPaintHit = null;
  state.strokeStartHit = null;
  state.strokeProxyObject = null;
  state.strokeProxyPositions = null;
  state.strokeProxySpatialIndex = null;
  state.strokeProxySpatialSource = null;
  state.moveSurfaceDataByKey.clear();
  state.lastPointerClient = { x: event.clientX, y: event.clientY };
  state.strokeSnapshotDone = false;
  if (['sculpt', 'paint', 'measure'].includes(state.tool)) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    transform.enabled = false;
    transform.visible = false;
    orbit.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    scheduleBrushVisual(event);
  }

  if (state.tool === 'select') {
    const hit = intersectObjects(event);
    selectObject(hit ? hit.object : null);
    return;
  }

  if (state.tool === 'sculpt') {
    applySculptAtEvent(event);
    return;
  }

  if (state.tool === 'paint') {
    applyPaintAtEvent(event);
    return;
  }

  if (state.tool === 'measure') {
    applyMeasureAtEvent(event);
  }
}

function onPointerMove(event) {
  scheduleBrushVisual(event);
  if (!state.isPointerDown) return;
  if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) return;
  if (state.tool === 'sculpt') {
    // RAF batching: guardamos el evento más reciente; animate() lo aplica
    // una sola vez por frame. Desacopla la tasa de pointermove (120+ Hz en
    // tablets de alta frecuencia) del loop de render para tiempo real fluido.
    pendingSculptEvent = capturePointerEvent(event);
  } else if (state.tool === 'paint') {
    pendingPaintEvent = capturePointerEvent(event);
  } else if (state.tool === 'measure') {
    updateMeasurePreview(event);
  }
  state.lastPointerClient = { x: event.clientX, y: event.clientY };
}

function pointerMovedSinceLastStrokeEvent(event, thresholdPx = 0.5) {
  if (!state.lastPointerClient) return true;
  return Math.hypot(event.clientX - state.lastPointerClient.x, event.clientY - state.lastPointerClient.y) > thresholdPx;
}

function onPointerUp(event) {
  // Antes de cerrar el trazo, aplica el último evento pendiente del RAF.
  // Esto evita que la pincelada se corte antes del punto donde el usuario soltó el mouse.
  flushPendingStrokeEvents();
  // Si el pointerup llega con una posición ligeramente distinta al último
  // pointermove procesado, usa ese punto como cierre real del trazo.
  if (pointerMovedSinceLastStrokeEvent(event)) {
    if (state.tool === 'sculpt') applySculptAtEvent(capturePointerEvent(event));
    else if (state.tool === 'paint') applyPaintAtEvent(capturePointerEvent(event));
  }
  state.isPointerDown = false;
  pendingSculptEvent = null;
  pendingPaintEvent  = null;
  scheduleBrushVisual(event);
  state.lastSculptHit = null;
  state.lastPaintHit = null;
  state.strokeStartHit = null;
  state.strokeProxyObject = null;
  state.strokeProxyPositions = null;
  state.strokeProxySpatialIndex = null;
  state.strokeProxySpatialSource = null;
  state.moveSurfaceDataByKey.clear();
  state.lastPointerClient = null;
  state.isStroke = false;
  orbit.enabled = true;
  setTransformModeFromTool();
  try { canvas.releasePointerCapture(event.pointerId); } catch {}
  // Garantiza que las normales y bounds estén actualizados antes de capturar
  // el snapshot de historial de la operación terminada.
  flushSculptDirtyMeshes();
  finalizeStrokeHistory();
  if (state.tool === 'sculpt' || state.tool === 'paint') {
    updateDimensionInputs();
    scheduleBrushVisual(event);
  }
}

function pushStrokeHistory(label) {
  if (state.strokeSnapshotDone) return;
  const rec = getRecord(state.selected);
  if (!rec) return;
  const geometry = rec.mesh.geometry;
  const position = geometry.getAttribute('position');
  const isPaint = /pintura|textura/i.test(label);
  const isMask = /máscara|mascara/i.test(label);
  const dynamicTopologyStroke = !!ui.dynamicTopology?.checked && !isPaint && !isMask;

  state.activeStrokeHistory = {
    label,
    recordId: rec.id,
    kind: isPaint ? 'paint' : dynamicTopologyStroke ? 'geometryFull' : 'geometry',
    objectSnapshotBefore: dynamicTopologyStroke ? serializeObject(rec, { includeTexture: false }) : null,
    positionsBefore: !isPaint && position ? new Float32Array(position.array) : null,
    indexBefore: !isPaint && geometry.getIndex() ? new Uint32Array(geometry.getIndex().array) : null,
    uvBefore: !isPaint && geometry.getAttribute('uv') ? new Float32Array(geometry.getAttribute('uv').array) : null,
    masksBefore: !isPaint && geometry.userData.maskWeights ? new Float32Array(geometry.userData.maskWeights) : null,
    imageBefore: isPaint ? rec.textureSet.ctx.getImageData(0, 0, rec.textureSet.canvas.width, rec.textureSet.canvas.height) : null,
    dirtyBounds: null
  };
  state.strokeSnapshotDone = true;
}

function findChangedImageBounds(beforeData, afterData, width, height, candidate = null) {
  const startX = candidate ? Math.max(0, Math.floor(candidate.x)) : 0;
  const startY = candidate ? Math.max(0, Math.floor(candidate.y)) : 0;
  const endX = candidate ? Math.min(width, Math.ceil(candidate.x + candidate.width)) : width;
  const endY = candidate ? Math.min(height, Math.ceil(candidate.y + candidate.height)) : height;
  let minX = endX;
  let minY = endY;
  let maxX = -1;
  let maxY = -1;
  for (let y = startY; y < endY; y++) {
    const row = y * width * 4;
    for (let x = startX; x < endX; x++) {
      const i = row + x * 4;
      if (
        beforeData[i] !== afterData[i] ||
        beforeData[i + 1] !== afterData[i + 1] ||
        beforeData[i + 2] !== afterData[i + 2] ||
        beforeData[i + 3] !== afterData[i + 3]
      ) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function extractImagePatch(data, fullWidth, bounds) {
  const patch = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) {
    const srcStart = ((bounds.y + y) * fullWidth + bounds.x) * 4;
    const srcEnd = srcStart + bounds.width * 4;
    patch.set(data.subarray(srcStart, srcEnd), y * bounds.width * 4);
  }
  return patch;
}

function buildPositionDelta(before, after) {
  if (!before || !after || before.length !== after.length) return null;
  const changed = [];
  const beforeValues = [];
  const afterValues = [];
  const eps = 1e-7;
  for (let i = 0; i < after.length; i += 3) {
    if (
      Math.abs(before[i] - after[i]) > eps ||
      Math.abs(before[i + 1] - after[i + 1]) > eps ||
      Math.abs(before[i + 2] - after[i + 2]) > eps
    ) {
      changed.push(i / 3);
      beforeValues.push(before[i], before[i + 1], before[i + 2]);
      afterValues.push(after[i], after[i + 1], after[i + 2]);
    }
  }
  if (!changed.length) return null;
  return {
    indices: new Uint32Array(changed),
    before: new Float32Array(beforeValues),
    after: new Float32Array(afterValues)
  };
}

function buildScalarDelta(before, after) {
  if (!before || !after || before.length !== after.length) return null;
  const changed = [];
  const beforeValues = [];
  const afterValues = [];
  const eps = 1e-6;
  for (let i = 0; i < after.length; i++) {
    if (Math.abs(before[i] - after[i]) > eps) {
      changed.push(i);
      beforeValues.push(before[i]);
      afterValues.push(after[i]);
    }
  }
  if (!changed.length) return null;
  return {
    indices: new Uint32Array(changed),
    before: new Float32Array(beforeValues),
    after: new Float32Array(afterValues)
  };
}

function finalizeStrokeHistory() {
  const stroke = state.activeStrokeHistory;
  state.activeStrokeHistory = null;
  if (!stroke) return;
  const rec = state.recordsById.get(stroke.recordId);
  if (!rec) return;

  let entry = null;

  if (stroke.kind === 'paint') {
    const canvas = rec.textureSet.canvas;
    const ctx = rec.textureSet.ctx;
    const after = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bounds = findChangedImageBounds(
      stroke.imageBefore.data,
      after.data,
      canvas.width,
      canvas.height,
      stroke.dirtyBounds
    );
    if (bounds) {
      entry = {
        kind: 'paintDelta',
        label: stroke.label,
        recordId: rec.id,
        apply: 'before',
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        before: extractImagePatch(stroke.imageBefore.data, canvas.width, bounds),
        after: extractImagePatch(after.data, canvas.width, bounds)
      };
    }
  } else {
    const geometry = rec.mesh.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const uv = geometry.getAttribute('uv');
    const topologyChanged =
      stroke.kind === 'geometryFull' && (
        !position || !stroke.positionsBefore || position.array.length !== stroke.positionsBefore.length ||
        (!!index !== !!stroke.indexBefore) ||
        (index && stroke.indexBefore && index.array.length !== stroke.indexBefore.length) ||
        (!!uv !== !!stroke.uvBefore) ||
        (uv && stroke.uvBefore && uv.array.length !== stroke.uvBefore.length)
      );

    if (topologyChanged && stroke.objectSnapshotBefore) {
      // Dynamic topology cambia el número de vértices/índices. En ese caso no
      // es seguro aplicar un delta por vértice; guardamos un snapshot completo
      // solo para esos trazos. El resto de trazos sigue usando deltas livianos.
      entry = {
        kind: 'object',
        label: stroke.label + ' + dynamic topology',
        recordId: rec.id,
        snapshot: stroke.objectSnapshotBefore
      };
    } else {
      const positions = buildPositionDelta(stroke.positionsBefore, position?.array);
      const masks = buildScalarDelta(stroke.masksBefore, rec.mesh.geometry.userData.maskWeights);
      if (positions || masks) {
        entry = {
          kind: 'geometryDelta',
          label: stroke.label,
          recordId: rec.id,
          apply: 'before',
          positions,
          masks
        };
      }
    }
  }

  if (!entry) return;
  addHistoryEntry(entry, state.undo);
  trimUndoHistory();
  clearHistoryStack('redo');
  updateHistoryButtons();
}

function applySculptAtEvent(event) {
  let mode = getActiveSculptMode(event);
  if (mode === 'transform') {
    setTool('move');
    setStatus('Transform activo: usa el gizmo del objeto seleccionado');
    return;
  }

  let hit = intersectObjects(event);
  // SculptGL Move mantiene el conjunto de vértices tomado al iniciar el trazo.
  // Por eso debe seguir funcionando aunque el cursor salga momentáneamente de la malla.
  if (!hit && mode === 'moveSurface' && state.strokeStartHit?.object) {
    hit = {
      object: state.strokeStartHit.object,
      point: state.strokeStartHit.point.clone(),
      normal: state.strokeStartHit.normal.clone(),
      uv: state.strokeStartHit.uv,
      face: state.strokeStartHit.face,
      pointerType: event.pointerType || state.strokeStartHit.pointerType || 'mouse',
      pressure: getPointerPressure(event)
    };
  }
  if (!hit) return;
  selectObject(hit.object);
  pushStrokeHistory(mode === 'masking' ? 'Trazo de máscara' : 'Trazo de escultura');

  const normal = getHitWorldNormal(hit);
  const current = {
    object: hit.object,
    point: hit.point.clone(),
    normal,
    uv: hit.uv ? hit.uv.clone() : null,
    face: hit.face,
    clientX: event.clientX,
    clientY: event.clientY,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey || event.metaKey,
    shiftKey: event.shiftKey,
    pointerType: event.pointerType || 'mouse',
    pressure: getPointerPressure(event)
  };

  if (!state.strokeStartHit || state.strokeStartHit.object !== current.object) {
    state.strokeStartHit = current;
    state.strokeProxyObject = current.object;
    state.strokeProxyPositions = new Float32Array(current.object.geometry.getAttribute('position').array);
  }

  // SculptGL no aplica un único golpe por evento de mouse: interpola sellos
  // a lo largo del trazo con separación proporcional al radio. Esto evita
  // marcas dentadas y deformaciones punzantes cuando el cursor se mueve rápido.
  const previous = state.lastSculptHit && state.lastSculptHit.object === current.object ? state.lastSculptHit : null;
  const radius = getSculptWorldRadius(current);

  // Dynamic Topology se evalúa una sola vez por evento físico del puntero.
  // Los sellos interpolados y sus reflejos de simetría trabajan después sobre
  // la misma topología, evitando varias reconstrucciones globales en un frame.
  if (mode !== 'masking') applyDynamicTopologyIfNeeded(current.object, current, radius, mode);

  // Move de SculptGL no funciona como una sucesión de sellos acumulativos:
  // congela un proxy al inicio y reubica ese proxy según el desplazamiento de pantalla.
  // Si lo interpolamos como Brush, se vuelve Drag y no Move.
  const stamps = mode === 'moveSurface' ? [current] : buildStrokeStamps(previous, current, Math.max(0.0015, radius * 0.14));
  let prevStamp = previous;

  for (const stamp of stamps) {
    stamp.symmetryKey = 'base';
    sculpt(stamp, prevStamp, mode, event);
    for (const axes of getActiveSymmetryCombinations()) {
      const mirrorHit = mirrorHitAcrossAxes(stamp, axes);
      const mirrorPrev = prevStamp ? mirrorHitAcrossAxes(prevStamp, axes) : null;
      if (mirrorHit) {
        mirrorHit.symmetryKey = axes.join('');
        if (mirrorPrev) mirrorPrev.symmetryKey = axes.join('');
        sculpt(mirrorHit, mirrorPrev, mode, event);
      }
    }
    prevStamp = stamp;
  }

  state.lastSculptHit = current;
}

function getActiveSculptMode(event = null) {
  if (event?.shiftKey) return 'smooth';
  if (event?.ctrlKey || event?.metaKey) return 'masking';
  return ui.sculptMode.value;
}

function isNegativeStroke(event = null) {
  return !!(ui.negative?.checked || event?.altKey);
}

function getHitWorldNormal(hit) {
  if (hit.normal) return hit.normal.clone().normalize();
  return hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
}

function buildStrokeStamps(previous, current, spacing) {
  if (!previous) return [current];
  const distance = previous.point.distanceTo(current.point);
  // Un salto grande del cursor no debe congelar la interfaz generando cientos
  // de sellos en un solo frame. El RAF siguiente continúa el trazo.
  const steps = Math.min(64, Math.max(1, Math.ceil(distance / spacing)));
  const stamps = [];
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const point = previous.point.clone().lerp(current.point, t);
    const normal = previous.normal.clone().lerp(current.normal, t).normalize();
    const uv = previous.uv && current.uv ? previous.uv.clone().lerp(current.uv, t) : current.uv;
    stamps.push({
      object: current.object,
      point,
      normal,
      uv,
      face: current.face,
      clientX: THREE.MathUtils.lerp(previous.clientX ?? current.clientX, current.clientX, t),
      clientY: THREE.MathUtils.lerp(previous.clientY ?? current.clientY, current.clientY, t),
      altKey: current.altKey,
      ctrlKey: current.ctrlKey,
      shiftKey: current.shiftKey,
      pointerType: current.pointerType || 'mouse',
      pressure: previous.pressure !== undefined && current.pressure !== undefined
        ? THREE.MathUtils.lerp(previous.pressure, current.pressure, t)
        : current.pressure
    });
  }
  return stamps;
}

function getActiveSymmetryCombinations() {
  const axes = [];
  if (ui.symmetry?.checked) axes.push('x');
  if (ui.symmetryY?.checked) axes.push('y');
  if (ui.symmetryZ?.checked) axes.push('z');
  const combos = [];
  for (let mask = 1; mask < (1 << axes.length); mask++) {
    const combo = [];
    for (let i = 0; i < axes.length; i++) if (mask & (1 << i)) combo.push(axes[i]);
    combos.push(combo);
  }
  return combos;
}

function mirrorHitAcrossAxes(hit, axes = []) {
  if (!hit?.object || !axes.length) return null;
  const mesh = hit.object;
  mesh.updateMatrixWorld(true);
  const inverseWorld = mesh.matrixWorld.clone().invert();
  const localPoint = hit.point.clone().applyMatrix4(inverseWorld);
  const localNormalMatrix = new THREE.Matrix3().getNormalMatrix(inverseWorld);
  const worldNormalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const localNormal = hit.normal.clone().applyMatrix3(localNormalMatrix).normalize();

  for (const axis of axes) {
    localPoint[axis] *= -1;
    localNormal[axis] *= -1;
  }

  return {
    object: mesh,
    point: localPoint.applyMatrix4(mesh.matrixWorld),
    normal: localNormal.applyMatrix3(worldNormalMatrix).normalize(),
    uv: hit.uv,
    face: hit.face,
    clientX: hit.clientX,
    clientY: hit.clientY,
    altKey: hit.altKey,
    ctrlKey: hit.ctrlKey,
    shiftKey: hit.shiftKey,
    pointerType: hit.pointerType || 'mouse',
    pressure: hit.pressure
  };
}

function collectAffectedGroups(mesh, hit, radius, normalMatrix) {
  let geometry = mesh.geometry;
  let pos = geometry.getAttribute('position');
  const normalAttr = geometry.getAttribute('normal');
  ensureMaskData(geometry);
  const topology = getSculptTopology(geometry);
  const affected = [];
  const weightedCenter = new THREE.Vector3();
  const weightedNormal = new THREE.Vector3();
  let weightSum = 0;

  const useProxy = (ui.accumulate && !ui.accumulate.checked || ui.lockPosition?.checked) && state.strokeProxyObject === mesh && state.strokeProxyPositions;

  // Pass 08: broadphase espacial. Antes se recorrían todos los grupos de la
  // malla por cada sello. Con mallas subdivididas eso era el mayor cuello de
  // botella. El spatial hash devuelve solo candidatos dentro de la vecindad del
  // pincel; luego mantenemos la comprobación exacta en espacio mundo.
  const invWorld = tmpM.copy(mesh.matrixWorld).invert();
  const localHit = tmpLocal.copy(hit.point).applyMatrix4(invWorld);
  const localRadius = worldRadiusToSafeLocalRadius(mesh, radius);
  const spatialIndex = useProxy ? getProxySpatialIndex(geometry, topology) : getCurrentSpatialIndex(geometry, topology);
  const candidates = querySpatialIndex(spatialIndex, localHit, localRadius, topology.spatialQueryResult || (topology.spatialQueryResult = []));
  const useAllGroups = candidates.length === 0;
  const loopCount = useAllGroups ? topology.groups.length : candidates.length;

  for (let c = 0; c < loopCount; c++) {
    const groupId = useAllGroups ? c : candidates[c];
    const group = topology.groups[groupId];

    getGroupLocalPosition(pos, group, tmpLocal);
    tmpWorld.copy(tmpLocal).applyMatrix4(mesh.matrixWorld);

    if (useProxy) getGroupLocalPositionFromArray(state.strokeProxyPositions, group, tmpLocal2);
    else tmpLocal2.copy(tmpLocal);
    tmpWorld2.copy(tmpLocal2).applyMatrix4(mesh.matrixWorld);

    const dist = tmpWorld2.distanceTo(hit.point);
    if (dist > radius) continue;

    let falloff = sculptFalloff(dist / radius);
    if (falloff <= 0) continue;
    const normal = getGroupWorldNormal(normalAttr, group, normalMatrix, tmpNormal);

    if (ui.thinSurface?.checked) {
      tmpToCamera.copy(camera.position).sub(tmpWorld).normalize();
      if (normal.dot(tmpToCamera) < 0.0) continue;
    }

    const mask = getGroupMask(geometry, group);
    // La máscara trabaja como en SculptGL: 1 = editable, 0 = protegido.
    const effectiveFalloff = falloff * mask;
    if (effectiveFalloff <= 0) continue;

    // Solo alocamos vectores para vértices realmente afectados, no para cada
    // grupo de la malla. Esto elimina miles de new Vector3() por sello.
    const world = tmpWorld.clone();
    const refWorld = tmpWorld2.clone();
    const storedNormal = normal.clone();
    affected.push({ groupId, group, falloff, effectiveFalloff, mask, world, refWorld, normal: storedNormal });
    weightedCenter.addScaledVector(refWorld, effectiveFalloff);
    weightedNormal.addScaledVector(storedNormal, effectiveFalloff);
    weightSum += effectiveFalloff;
  }

  if (weightSum > 0) {
    weightedCenter.divideScalar(weightSum);
    if (weightedNormal.lengthSq() > 0) weightedNormal.normalize();
    else weightedNormal.copy(hit.normal);
  }
  return { affected, weightedCenter, weightedNormal, topology };
}

function getGroupWorldPosition(mesh, groupId, target = new THREE.Vector3()) {
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute('position');
  const topology = getSculptTopology(geometry);
  const group = topology.groups[groupId];
  getGroupLocalPosition(pos, group, target);
  return target.applyMatrix4(mesh.matrixWorld);
}

function setGroupWorldPosition(mesh, group, worldPosition, inverseWorld = null, position = null) {
  const inv = inverseWorld || tmpM.copy(mesh.matrixWorld).invert();
  tmpWorld.copy(worldPosition).applyMatrix4(inv);
  setGroupLocalPosition(position || mesh.geometry.getAttribute('position'), group, tmpWorld);
}

function computeNeighborAverageWorld(mesh, topology, groupId, target = new THREE.Vector3()) {
  const group = topology.groups[groupId];
  const neighbors = group.neighbors;
  const position = mesh.geometry.getAttribute('position');
  target.set(0, 0, 0);
  if (!neighbors.length) {
    getGroupLocalPosition(position, group, target);
    return target.applyMatrix4(mesh.matrixWorld);
  }
  for (const neighborId of neighbors) {
    getGroupLocalPosition(position, topology.groups[neighborId], tmpV3);
    target.add(tmpV3.applyMatrix4(mesh.matrixWorld));
  }
  return target.divideScalar(neighbors.length);
}

function relaxAffectedGroups(mesh, affected, topology, amount, inverseWorld = null, position = null) {
  if (!affected.length || amount <= 0) return;
  const targets = new Map();
  for (const item of affected) {
    const current = getGroupWorldPosition(mesh, item.groupId, tmpWorld).clone();
    const average = computeNeighborAverageWorld(mesh, topology, item.groupId, tmpWorld2);
    const alpha = Math.min(0.35, amount * item.falloff);
    targets.set(item.groupId, current.lerp(average, alpha));
  }
  for (const item of affected) {
    setGroupWorldPosition(mesh, item.group, targets.get(item.groupId), inverseWorld, position);
  }
}

function getPlanePointFromClient(clientX, clientY, planePoint, planeNormal, target = new THREE.Vector3()) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const denom = planeNormal.dot(raycaster.ray.direction);
  if (Math.abs(denom) < 1e-5) return target.copy(planePoint);
  const t = planePoint.clone().sub(raycaster.ray.origin).dot(planeNormal) / denom;
  if (!Number.isFinite(t)) return target.copy(planePoint);
  return target.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, t);
}

function getScreenPlaneDelta(previousHit, hit, planePoint) {
  if (!previousHit || previousHit.clientX === undefined || hit.clientX === undefined) return new THREE.Vector3();
  const viewNormal = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const p0 = getPlanePointFromClient(previousHit.clientX, previousHit.clientY, planePoint, viewNormal, new THREE.Vector3());
  const p1 = getPlanePointFromClient(hit.clientX, hit.clientY, planePoint, viewNormal, new THREE.Vector3());
  return p1.sub(p0);
}


function getRayClosestPointToWorldPoint(clientX, clientY, point, target = new THREE.Vector3()) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.closestPointToPoint(point, target);
}

function createMoveSurfaceData(mesh, hit, radius, normalMatrix) {
  const { affected, weightedCenter, weightedNormal, topology } = collectAffectedGroups(mesh, hit, radius, normalMatrix);
  const center = weightedCenter.lengthSq() > 0 ? weightedCenter.clone() : hit.point.clone();
  const normal = weightedNormal.lengthSq() > 0 ? weightedNormal.clone() : hit.normal.clone();
  const entries = affected.map((item) => ({
    groupId: item.groupId,
    group: item.group,
    falloff: item.effectiveFalloff,
    originalWorld: item.world.clone()
  }));
  return {
    mesh,
    center,
    normal: normal.normalize(),
    radius,
    topology,
    entries,
    startClientX: hit.clientX ?? 0,
    startClientY: hit.clientY ?? 0,
    lastClientX: hit.clientX ?? 0,
    lastClientY: hit.clientY ?? 0
  };
}

function applyMoveSurfaceLikeSculptGL(mesh, hit, event, radius, normalMatrix) {
  const key = hit.symmetryKey || 'base';
  let data = state.moveSurfaceDataByKey.get(key);
  if (!data || data.mesh !== mesh || !data.entries.length) {
    data = createMoveSurfaceData(mesh, hit, radius, normalMatrix);
    state.moveSurfaceDataByKey.set(key, data);
  }
  if (!data.entries.length) return false;

  const strength = parseFloat(ui.brushStrength.value) * getPointerPressure(hit || event);
  const moveIntensity = THREE.MathUtils.clamp(strength / 0.025, 0.25, 2.5);
  const dir = new THREE.Vector3();
  const negative = isNegativeStroke(event || hit);

  if (negative) {
    // En SculptGL, Move con negativo cambia a desplazamiento a lo largo de la normal
    // de la zona, usando la variación horizontal del mouse como magnitud.
    const px = hit.clientX ?? data.lastClientX;
    const dx = px - data.startClientX;
    const units = getWorldUnitsPerPixelAt(data.center);
    dir.copy(data.normal).multiplyScalar(dx * units * moveIntensity);
  } else {
    const px = hit.clientX ?? data.lastClientX;
    const py = hit.clientY ?? data.lastClientY;
    const closest = getRayClosestPointToWorldPoint(px, py, data.center, new THREE.Vector3());
    dir.copy(closest).sub(data.center).multiplyScalar(moveIntensity);
  }

  const inverseWorld = mesh.matrixWorld.clone().invert();
  const position = mesh.geometry.getAttribute('position');
  for (const item of data.entries) {
    const target = item.originalWorld.clone().addScaledVector(dir, item.falloff);
    setGroupWorldPosition(mesh, item.group, target, inverseWorld, position);
  }

  data.lastClientX = hit.clientX ?? data.lastClientX;
  data.lastClientY = hit.clientY ?? data.lastClientY;
  updateSpatialIndexGroups(mesh.geometry, data.topology, data.entries);
  return true;
}

function getTwistAngle(previousHit, hit) {
  const center = state.strokeStartHit || previousHit;
  if (!previousHit || !center || previousHit.clientX === undefined || hit.clientX === undefined) return 0;
  const ax = previousHit.clientX - center.clientX;
  const ay = previousHit.clientY - center.clientY;
  const bx = hit.clientX - center.clientX;
  const by = hit.clientY - center.clientY;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 8 || lb < 8) return 0;
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  return Math.atan2(cross, dot);
}

function sculpt(hit, previousHit = null, modeOverride = null, event = null) {
  const mesh = hit.object;
  let geometry = mesh.geometry;
  let pos = geometry.getAttribute('position');
  if (!pos) return;

  const mode = modeOverride || ui.sculptMode.value;
  if (mode === 'masking') {
    maskStroke(hit, event);
    return;
  }

  const strength = parseFloat(ui.brushStrength.value) * getPointerPressure(hit || event);
  const negative = isNegativeStroke(event || hit);

  mesh.updateMatrixWorld(true);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  ensureMaskData(geometry);
  const normalMatrix = tmpNormalMatrix.getNormalMatrix(mesh.matrixWorld);
  const safeHit = { ...hit, normal: hit.normal ? hit.normal.clone().normalize() : getHitWorldNormal(hit) };
  const pickingHit = ui.lockPosition?.checked && state.strokeStartHit?.object === mesh
    ? { ...safeHit, point: state.strokeStartHit.point.clone(), normal: state.strokeStartHit.normal.clone() }
    : safeHit;
  const radius = getSculptWorldRadius(pickingHit);

  if (mode === 'moveSurface') {
    const moved = applyMoveSurfaceLikeSculptGL(mesh, pickingHit, event, radius, normalMatrix);
    if (!moved) return;
    pos.needsUpdate = true;
    state.sculptDirtyMeshes.add(mesh);
    markWireframeDirty(mesh);
    return;
  }

  const { affected, weightedCenter, weightedNormal, topology } = collectAffectedGroups(mesh, pickingHit, radius, normalMatrix);
  if (!affected.length) return;

  // SculptGL Brush usa una intensidad proporcional a radius*0.1.
  // La versión anterior era varias veces más agresiva y convertía el Brush
  // en una meseta/faceta. Bajamos la ganancia para que el volumen suba
  // progresivamente como arcilla.
  // Las herramientas ya calibran su propia ganancia con una escala inspirada
  // en SculptGL: la intensidad suele ser proporcional a radius * 0.1, no a un
  // empuje genérico para todos los modos.
  const deformation = strength * radius * 0.105;
  // Suavizar necesita una escala mayor que los pinceles de desplazamiento.
  // 0.03 (valor inicial) equivale a 0.60 de interpolación en el centro.
  const smoothStrength = Math.min(0.92, strength * 20);
  const flattenStrength = Math.min(0.72, strength * 11);
  const planeNormal = weightedNormal.lengthSq() > 0 ? weightedNormal.clone() : safeHit.normal.clone();
  const planePoint = weightedCenter.lengthSq() > 0 ? weightedCenter.clone() : safeHit.point.clone();
  const sign = negative ? -1 : 1;
  const dragDelta = getScreenPlaneDelta(previousHit, hit, planePoint);
  const twistAngle = getTwistAngle(previousHit, hit);
  const twistAxis = camera.getWorldDirection(new THREE.Vector3()).negate().normalize();
  const localScaleDelta = previousHit
    ? (hit.clientX - previousHit.clientX) * 0.0025 * THREE.MathUtils.clamp(strength / 0.03, 0.35, 2.2) * (negative ? -1 : 1)
    : 0;
  const targets = new Map();

  for (const item of affected) {
    const worldPos = item.world.clone();
    const falloff = item.effectiveFalloff;
    if (falloff <= 0) continue;

    const applied = applySculptTool(mode, worldPos, item, {
      THREE,
      ui,
      state,
      mesh,
      topology,
      strength,
      radius,
      deformation,
      smoothStrength,
      flattenStrength,
      smoothPreserveVolume: ui.smoothPreserveVolume?.checked !== false,
      smoothTangent: !!ui.smoothTangent?.checked,
      creasePinch: parseFloat(ui.creasePinch?.value || '1'),
      creaseDepth: parseFloat(ui.creaseDepth?.value || '1'),
      planeNormal,
      planePoint,
      brushCenter: pickingHit.point,
      sign,
      negative,
      dragDelta,
      twistAngle,
      twistAxis,
      localScaleDelta,
      computeNeighborAverageWorld,
      pseudoNoise
    });
    if (!applied) continue;

    targets.set(item.groupId, worldPos);
  }

  const inverseWorld = mesh.matrixWorld.clone().invert();
  for (const item of affected) {
    const target = targets.get(item.groupId);
    if (target) setGroupWorldPosition(mesh, item.group, target, inverseWorld, pos);
  }

  // Relajación pos-trazo. En SculptGL la topología coherente + normales suaves evitan púas;
  // aquí añadimos una relajación mínima para que Brush/Inflate/Crease no parezcan facetados.
  if (['brush', 'inflate', 'deflate', 'crease', 'noise'].includes(mode)) {
    const relax = mode === 'brush' ? 0.08 : mode === 'crease' ? 0.025 : mode === 'noise' ? 0.045 : 0.05;
    relaxAffectedGroups(mesh, affected, topology, relax, inverseWorld, pos);
  }

  pos.needsUpdate = true;
  // Defer: normales/bounds se recomputan al cierre del frame en flushSculptDirtyMeshes().
  // Ejecutar computeVertexNormals() por cada sello del trazo multiplicaba el costo
  // por la cantidad de stamps interpolados (hasta ~10 por evento de pointermove).
  updateSpatialIndexGroups(geometry, topology, affected);
  state.sculptDirtyMeshes.add(mesh);
  markWireframeDirty(mesh);
}

function maskStroke(hit, event = null) {
  const mesh = hit.object;
  const geometry = mesh.geometry;
  const strength = parseFloat(ui.brushStrength.value) * getPointerPressure(hit || event);
  mesh.updateMatrixWorld(true);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  ensureMaskData(geometry);
  const normalMatrix = tmpNormalMatrix.getNormalMatrix(mesh.matrixWorld);
  const pickingHit = ui.lockPosition?.checked && state.strokeStartHit?.object === mesh
    ? { ...hit, point: state.strokeStartHit.point.clone(), normal: state.strokeStartHit.normal.clone() }
    : hit;
  const radius = getSculptWorldRadius(pickingHit);
  const { affected } = collectAffectedGroups(mesh, pickingHit, radius, normalMatrix);
  if (!affected.length) return;

  // Por defecto pinta protección; Alt/N invierte y recupera zona editable.
  const restore = isNegativeStroke(event || hit);
  for (const item of affected) {
    const current = getGroupMask(geometry, item.group);
    const next = current + (restore ? 1 : -1) * item.falloff * Math.min(1, strength * 9);
    setGroupMask(geometry, item.group, next);
  }
  updateMaskColors(geometry, affected.map((item) => item.group));
}

function pseudoNoise(x, y, z) {
  return fract(Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453);
}
function fract(v) { return v - Math.floor(v); }

function applyPaintAtEvent(event) {
  const hit = intersectObjects(event);
  if (!hit || !hit.uv) return;
  selectObject(hit.object);
  pushStrokeHistory('Trazo de textura');

  const current = {
    object: hit.object,
    point: hit.point.clone(),
    uv: hit.uv.clone(),
    clientX: event.clientX,
    clientY: event.clientY,
    pointerType: event.pointerType || 'mouse',
    pressure: getPointerPressure(event)
  };
  const previous = state.lastPaintHit && state.lastPaintHit.object === current.object ? state.lastPaintHit : null;
  const radiusPx = parseFloat(ui.paintRadius.value);
  const worldSpacing = Math.max(0.003, radiusPx / 3600);
  const stamps = buildPaintStamps(previous, current, worldSpacing, radiusPx);
  for (const stamp of stamps) paintAtHit(stamp);
  state.lastPaintHit = current;
}

function buildPaintStamps(previous, current, spacing, radiusPx) {
  if (!previous) return [current];
  const distance = previous.point.distanceTo(current.point);
  const screenDistance = Math.hypot(current.clientX - previous.clientX, current.clientY - previous.clientY);
  const screenSpacing = Math.max(2, radiusPx * 0.18);
  const steps = Math.min(72, Math.max(1, Math.ceil(Math.max(distance / spacing, screenDistance / screenSpacing))));
  const stamps = [];
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    stamps.push({
      object: current.object,
      point: previous.point.clone().lerp(current.point, t),
      uv: interpolateUvAcrossSeam(previous.uv, current.uv, t),
      clientX: THREE.MathUtils.lerp(previous.clientX, current.clientX, t),
      clientY: THREE.MathUtils.lerp(previous.clientY, current.clientY, t),
      pointerType: current.pointerType || 'mouse',
      pressure: previous.pressure !== undefined && current.pressure !== undefined
        ? THREE.MathUtils.lerp(previous.pressure, current.pressure, t)
        : current.pressure
    });
  }
  return stamps;
}

function normalizeUv01(value) {
  return ((value % 1) + 1) % 1;
}

function interpolateUvAcrossSeam(a, b, t) {
  if (!a || !b) return b ? b.clone() : null;
  let u0 = a.x;
  let u1 = b.x;
  const du = u1 - u0;
  // Si el trazo cruza la costura de la esfera, no interpolamos por el centro
  // completo de la textura. Elegimos el camino corto sobre U con wrap.
  if (du > 0.5) u0 += 1;
  else if (du < -0.5) u1 += 1;
  return new THREE.Vector2(
    normalizeUv01(THREE.MathUtils.lerp(u0, u1, t)),
    THREE.MathUtils.lerp(a.y, b.y, t)
  );
}

function markPaintDirtyBounds(recordId, x, y, radius, width, height) {
  const stroke = state.activeStrokeHistory;
  if (!stroke || stroke.kind !== 'paint' || stroke.recordId !== recordId) return;
  const x0 = Math.max(0, Math.floor(x - radius - 2));
  const y0 = Math.max(0, Math.floor(y - radius - 2));
  const x1 = Math.min(width, Math.ceil(x + radius + 2));
  const y1 = Math.min(height, Math.ceil(y + radius + 2));
  if (x1 <= x0 || y1 <= y0) return;
  if (!stroke.dirtyBounds) {
    stroke.dirtyBounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    return;
  }
  const current = stroke.dirtyBounds;
  const right = Math.max(current.x + current.width, x1);
  const bottom = Math.max(current.y + current.height, y1);
  current.x = Math.min(current.x, x0);
  current.y = Math.min(current.y, y0);
  current.width = right - current.x;
  current.height = bottom - current.y;
}

function paintAtHit(hit) {
  const rec = getRecord(hit.object);
  if (!rec || !hit.uv) return;
  const { canvas: texCanvas, ctx, texture } = rec.textureSet;
  const radius = parseFloat(ui.paintRadius.value);
  const opacity = parseFloat(ui.paintOpacity.value) * getPointerPressure(hit);
  const color = ui.paintColor.value;
  const u = normalizeUv01(hit.uv.x) * texCanvas.width;
  const v = (1 - THREE.MathUtils.clamp(hit.uv.y, 0, 1)) * texCanvas.height;

  ctx.save();
  ctx.globalAlpha = opacity;
  drawPaintStamp(ctx, u, v, radius, color);
  markPaintDirtyBounds(rec.id, u, v, radius, texCanvas.width, texCanvas.height);

  // Pintura sin costura: si el pincel toca U=0/U=1, se replica al otro lado
  // del canvas. Así una esfera se comporta como un objeto cerrado, no como
  // una textura rectangular partida.
  if (u - radius < 0) {
    drawPaintStamp(ctx, u + texCanvas.width, v, radius, color);
    markPaintDirtyBounds(rec.id, 0, v, radius, texCanvas.width, texCanvas.height);
  }
  if (u + radius > texCanvas.width) {
    drawPaintStamp(ctx, u - texCanvas.width, v, radius, color);
    markPaintDirtyBounds(rec.id, texCanvas.width, v, radius, texCanvas.width, texCanvas.height);
  }
  ctx.restore();
  texture.needsUpdate = true;
}

function getPaintBrushStamp(radius, color) {
  const r = Math.max(1, Math.round(radius));
  const key = `${r}:${color}`;
  if (paintBrushCache.has(key)) return paintBrushCache.get(key);

  const padding = 2;
  const size = r * 2 + padding * 2;
  const stamp = document.createElement('canvas');
  stamp.width = size;
  stamp.height = size;
  const stampCtx = stamp.getContext('2d');
  const center = size / 2;
  const gradient = stampCtx.createRadialGradient(center, center, 0, center, center, r);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.72, color);
  gradient.addColorStop(1, hexToRgba(color, 0));
  stampCtx.fillStyle = gradient;
  stampCtx.beginPath();
  stampCtx.arc(center, center, r, 0, Math.PI * 2);
  stampCtx.fill();

  const result = { canvas: stamp, center };
  paintBrushCache.set(key, result);
  if (paintBrushCache.size > 24) paintBrushCache.delete(paintBrushCache.keys().next().value);
  return result;
}

function drawPaintStamp(ctx, u, v, radius, color) {
  const stamp = getPaintBrushStamp(radius, color);
  ctx.drawImage(stamp.canvas, u - stamp.center, v - stamp.center);
}

function updateBrushVisual(event) {
  if (!['sculpt', 'paint'].includes(state.tool)) {
    brushRing.visible = false;
    brushDot.visible = false;
    brushPreview.style.display = 'none';
    return;
  }
  const hit = intersectObjects(event);
  if (!hit) {
    brushRing.visible = false;
    brushDot.visible = false;
    brushPreview.style.display = 'none';
    return;
  }
  const activeMode = state.tool === 'sculpt' ? getActiveSculptMode(event) : 'paint';
  const paintLike = state.tool === 'paint' || activeMode === 'paint';
  const screenRadius = paintLike ? Math.max(8, parseFloat(ui.paintRadius.value) * 0.75) : getSculptScreenRadiusPx();
  const radius = screenRadiusToWorldRadius(hit.point, screenRadius);
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  const cursorPos = hit.point.clone().addScaledVector(normal, 0.002);
  const showOnlyCenter = state.isPointerDown && ['sculpt', 'paint'].includes(state.tool);

  brushRing.position.copy(cursorPos);
  brushRing.scale.setScalar(radius);
  tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  brushRing.quaternion.copy(tmpQ);
  brushRing.visible = !showOnlyCenter;

  brushDot.position.copy(cursorPos);
  brushDot.scale.setScalar(Math.max(screenRadiusToWorldRadius(hit.point, 2.8), radius * 0.024));
  brushDot.visible = true;

  const rect = canvas.getBoundingClientRect();
  brushPreview.style.display = paintLike && !showOnlyCenter ? 'block' : 'none';
  brushPreview.style.left = `${event.clientX - rect.left}px`;
  brushPreview.style.top = `${event.clientY - rect.top}px`;
  const d = Math.max(12, parseFloat(ui.paintRadius.value) * 0.75);
  brushPreview.style.width = `${d}px`;
  brushPreview.style.height = `${d}px`;
  brushPreview.style.marginLeft = `${-d / 2}px`;
  brushPreview.style.marginTop = `${-d / 2}px`;
}

function applyMeasureAtEvent(event) {
  const hit = intersectObjects(event);
  if (!hit) return;
  if (!state.measureStart) {
    state.measureStart = hit.point.clone();
    if (state.measureLine) scene.remove(state.measureLine);
    const geom = new THREE.BufferGeometry().setFromPoints([state.measureStart, state.measureStart]);
    state.measureLine = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xffb000 }));
    scene.add(state.measureLine);
    setStatus('Medición: elige el segundo punto');
  } else {
    const dist = state.measureStart.distanceTo(hit.point);
    setStatus(`Medición: ${dist.toFixed(3)} unidades`);
    state.measureStart = null;
  }
}

function updateMeasurePreview(event) {
  if (!state.measureStart || !state.measureLine) return;
  const hit = intersectObjects(event);
  if (!hit) return;
  const arr = state.measureLine.geometry.attributes.position.array;
  arr[0] = state.measureStart.x; arr[1] = state.measureStart.y; arr[2] = state.measureStart.z;
  arr[3] = hit.point.x; arr[4] = hit.point.y; arr[5] = hit.point.z;
  state.measureLine.geometry.attributes.position.needsUpdate = true;
  setStatus(`Medición: ${state.measureStart.distanceTo(hit.point).toFixed(3)} unidades`);
}

function duplicateSelected() {
  if (!state.selected) return;
  const rec = getRecord();
  const texSet = makeTextureCanvas('#ffffff', rec.textureSet.canvas.width);
  texSet.ctx.drawImage(rec.textureSet.canvas, 0, 0);
  texSet.texture.needsUpdate = true;
  const clonedGeometry = rec.mesh.geometry.clone();
  ensureMaskData(clonedGeometry);
  buildSculptTopology(clonedGeometry);
  smoothNormalsByWeldedGroups(clonedGeometry);
  const mesh = new THREE.Mesh(clonedGeometry, createMaterial(texSet));
  mesh.name = rec.mesh.name + ' copia';
  mesh.position.copy(rec.mesh.position).add(new THREE.Vector3(0.35, 0.1, 0.35));
  mesh.rotation.copy(rec.mesh.rotation);
  mesh.scale.copy(rec.mesh.scale);
  mesh.castShadow = true;
  // No recibe su propia sombra: así la superficie queda visualmente lisa, sin bandas.
  mesh.receiveShadow = false;
  const newRec = { id: state.idCounter++, type: rec.type, mesh, textureSet: texSet, pbrMaterial: mesh.material, matcapMaterials: new Map(), createdAt: Date.now() };
  mesh.userData.recordId = newRec.id;
  state.objects.push(newRec);
  registerRecord(newRec);
  scene.add(mesh);
  selectObject(mesh);
  pushObjectsAdded('Duplicar objeto', [newRec]);
}

function deleteSelected() {
  if (!state.selected) return;
  const rec = getRecord();
  pushObjectsDeleted('Eliminar objeto', [rec]);
  state.objects = state.objects.filter((obj) => obj !== rec);
  disposeRecord(rec);
  selectObject(null);
}

function clearScene() {
  if (state.objects.length > 1 || state.objects.some((rec) => rec.mesh.name !== 'Esfera 1')) {
    const ok = window.confirm('¿Crear una escena nueva? Se eliminarán los objetos actuales. Puedes deshacer después con Ctrl+Z.');
    if (!ok) return;
  }
  pushHistory('Nueva escena');
  for (const rec of [...state.objects]) disposeRecord(rec);
  state.objects.length = 0;
  state.recordsByMesh.clear();
  state.recordsById.clear();
  state.selected = null;
  transform.detach();
  state.measureStart = null;
  if (state.measureLine) {
    scene.remove(state.measureLine);
    state.measureLine.geometry?.dispose?.();
    state.measureLine.material?.dispose?.();
    state.measureLine = null;
  }
  addPrimitive('sphere', { skipHistory: true });
  setStatus('Escena nueva');
}

function centerSelected() {
  if (!state.selected) return;
  pushObjectHistory('Centrar objeto');
  const box = new THREE.Box3().setFromObject(state.selected);
  const center = box.getCenter(new THREE.Vector3());
  state.selected.position.x -= center.x;
  state.selected.position.z -= center.z;
  const afterXZ = new THREE.Box3().setFromObject(state.selected);
  state.selected.position.y -= afterXZ.min.y;
  updateDimensionInputs();
}

function frameSelection() {
  const target = state.selected;
  if (!target) return;
  const box = new THREE.Box3().setFromObject(target);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 0.5);
  const distance = maxSize / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const dir = camera.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, distance * 1.15);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = Math.max(200, distance * 100);
  camera.updateProjectionMatrix();
  orbit.update();
}

function serializeTexture(rec) {
  const { canvas, ctx } = rec.textureSet;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: new Uint8ClampedArray(image.data)
  };
}

function serializeObject(rec, options = {}) {
  const geo = rec.mesh.geometry;
  const position = geo.getAttribute('position');
  const normal = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const index = geo.getIndex();
  return {
    id: rec.id,
    type: rec.type,
    name: rec.mesh.name,
    visible: rec.mesh.visible,
    orderIndex: state.objects.indexOf(rec),
    position: rec.mesh.position.toArray(),
    rotation: [rec.mesh.rotation.x, rec.mesh.rotation.y, rec.mesh.rotation.z],
    scale: rec.mesh.scale.toArray(),
    geometryPositions: cloneTypedArray(position.array),
    geometryNormals: normal ? cloneTypedArray(normal.array) : null,
    geometryIndex: index ? cloneTypedArray(index.array) : null,
    geometryUvs: uv ? cloneTypedArray(uv.array) : null,
    maskWeights: geo.userData.maskWeights ? cloneTypedArray(geo.userData.maskWeights) : null,
    // Se guardan píxeles crudos mediante structured clone. Esto elimina el
    // costoso canvas.toDataURL('image/png') de cada objeto y cada snapshot.
    texture: options.includeTexture ? serializeTexture(rec) : null,
    textureData: null, // compatibilidad con proyectos guardados por versiones anteriores
    roughness: getPbrMaterial(rec).roughness,
    metalness: getPbrMaterial(rec).metalness,
    wireframe: state.wireframeEnabled
  };
}

function commitHistoryEntry(entry) {
  addHistoryEntry(entry);
  trimUndoHistory();
  clearHistoryStack('redo');
  updateHistoryButtons();
}

function pushObjectHistory(label = 'Cambio de objeto', mesh = state.selected, options = {}) {
  const rec = getRecord(mesh);
  if (!rec) return;
  commitHistoryEntry({
    kind: 'object',
    label,
    recordId: rec.id,
    snapshot: serializeObject(rec, options)
  });
}

function pushObjectsAdded(label, records) {
  const recordIds = records.filter(Boolean).map((rec) => rec.id);
  if (!recordIds.length) return;
  commitHistoryEntry({ kind: 'objectBatch', label, action: 'remove', recordIds });
}

function pushObjectsDeleted(label, records) {
  const snapshots = records.filter(Boolean).map((rec) => serializeObject(rec, { includeTexture: true }));
  if (!snapshots.length) return;
  commitHistoryEntry({ kind: 'objectBatch', label, action: 'restore', snapshots });
}

function pushHistory(label = 'Cambio') {
  commitHistoryEntry({
    kind: 'scene',
    label,
    snapshot: serializeScene(label)
  });
}

function serializeScene(label = '') {
  return {
    label,
    selectedId: state.selected?.userData.recordId || null,
    idCounter: state.idCounter,
    objects: state.objects.map((rec) => serializeObject(rec, { includeTexture: true }))
  };
}

function createGeometryFromSnapshot(data) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(data.geometryPositions, 3));
  if (data.geometryUvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.geometryUvs, 2));
  setIndexAttribute(geo, data.geometryIndex);
  if (data.geometryNormals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.geometryNormals, 3));
  else geo.computeVertexNormals();
  ensureMaskData(geo);
  if (data.maskWeights && data.maskWeights.length === geo.getAttribute('position').count) {
    geo.userData.maskWeights = new Float32Array(data.maskWeights);
    updateMaskColors(geo);
  }
  buildSculptTopology(geo);
  smoothNormalsByWeldedGroups(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

async function restoreTextureSnapshot(data, textureSet) {
  if (data.texture?.pixels) {
    const width = data.texture.width || textureSet.canvas.width;
    const height = data.texture.height || textureSet.canvas.height;
    if (textureSet.canvas.width !== width) textureSet.canvas.width = width;
    if (textureSet.canvas.height !== height) textureSet.canvas.height = height;
    const pixels = new Uint8ClampedArray(data.texture.pixels);
    textureSet.ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    textureSet.texture.needsUpdate = true;
    return;
  }
  // Permite abrir proyectos guardados por versiones anteriores.
  if (data.textureData) {
    await drawDataUrlToCanvas(data.textureData, textureSet.canvas, textureSet.ctx);
    textureSet.texture.needsUpdate = true;
  }
}

async function createRecordFromSnapshot(data) {
  const geo = createGeometryFromSnapshot(data);
  const textureSize = data.texture?.width || 1024;
  const texSet = makeTextureCanvas('#ffffff', textureSize);
  await restoreTextureSnapshot(data, texSet);
  const mat = createMaterial(texSet);
  mat.roughness = data.roughness ?? mat.roughness;
  mat.metalness = data.metalness ?? mat.metalness;
  mat.wireframe = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = data.name;
  mesh.visible = data.visible !== false;
  mesh.position.fromArray(data.position);
  mesh.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
  mesh.scale.fromArray(data.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.userData.recordId = data.id;
  const rec = { id: data.id, type: data.type, mesh, textureSet: texSet, pbrMaterial: mesh.material, matcapMaterials: new Map(), createdAt: Date.now() };
  scene.add(mesh);
  const insertAt = Number.isInteger(data.orderIndex)
    ? THREE.MathUtils.clamp(data.orderIndex, 0, state.objects.length)
    : state.objects.length;
  state.objects.splice(insertAt, 0, rec);
  registerRecord(rec);
  state.idCounter = Math.max(state.idCounter, Number(data.id) + 1 || state.idCounter);
  applyViewMaterialToRecord(rec);
  setRecordWireframe(rec, state.wireframeEnabled);
  return rec;
}

async function restoreObjectSnapshot(data) {
  let rec = state.recordsById.get(data.id);
  if (!rec) {
    rec = await createRecordFromSnapshot(data);
    selectObject(rec.mesh);
    updateInspector();
    renderObjectList();
    return;
  }
  rec.type = data.type || rec.type;
  rec.mesh.name = data.name || rec.mesh.name;
  rec.mesh.visible = data.visible !== false;
  const oldGeometry = rec.mesh.geometry;
  disposeWireframeOverlay(rec);
  rec.mesh.geometry = createGeometryFromSnapshot(data);
  oldGeometry?.dispose?.();
  rec.mesh.position.fromArray(data.position);
  rec.mesh.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
  rec.mesh.scale.fromArray(data.scale);
  const pbr = getPbrMaterial(rec);
  pbr.roughness = data.roughness ?? pbr.roughness;
  pbr.metalness = data.metalness ?? pbr.metalness;
  pbr.wireframe = false;
  pbr.needsUpdate = true;
  applyViewMaterialToRecord(rec);
  setRecordWireframe(rec, state.wireframeEnabled);
  if (data.texture || data.textureData) await restoreTextureSnapshot(data, rec.textureSet);
  selectObject(rec.mesh);
  updateInspector();
  renderObjectList();
}

async function restoreObjectBatch(entry) {
  if (entry.action === 'remove') {
    const ids = new Set(entry.recordIds || []);
    const records = state.objects.filter((rec) => ids.has(rec.id));
    state.objects = state.objects.filter((rec) => !ids.has(rec.id));
    for (const rec of records) disposeRecord(rec);
    const selected = state.objects.at(-1)?.mesh || null;
    selectObject(selected);
    renderObjectList();
    return;
  }

  const restored = [];
  for (const snapshot of entry.snapshots || []) {
    const existing = state.recordsById.get(snapshot.id);
    if (existing) await restoreObjectSnapshot(snapshot);
    else restored.push(await createRecordFromSnapshot(snapshot));
  }
  selectObject(restored.at(-1)?.mesh || state.selected || state.objects.at(-1)?.mesh || null);
  updateInspector();
  renderObjectList();
}

async function restoreScene(snapshot, pushToRedo = false) {
  if (!snapshot) return;
  if (pushToRedo) addHistoryEntry({ kind: 'scene', label: 'redo', snapshot: serializeScene('redo') }, state.redo);
  for (const rec of [...state.objects]) disposeRecord(rec);
  state.objects = [];
  state.recordsByMesh.clear();
  state.recordsById.clear();
  state.idCounter = snapshot.idCounter || 1;
  for (const data of snapshot.objects || []) await createRecordFromSnapshot(data);
  const selected = state.objects.find((obj) => obj.id === snapshot.selectedId)?.mesh || state.objects.at(-1)?.mesh || null;
  selectObject(selected);
  updateHistoryButtons();
}

function applyGeometryDelta(entry) {
  const rec = state.recordsById.get(entry.recordId);
  if (!rec) return;
  const target = entry.apply === 'after' ? 'after' : 'before';
  const geometry = rec.mesh.geometry;
  const position = geometry.getAttribute('position');

  if (entry.positions && position) {
    const values = entry.positions[target];
    for (let i = 0; i < entry.positions.indices.length; i++) {
      const vertex = entry.positions.indices[i] * 3;
      const value = i * 3;
      position.array[vertex] = values[value];
      position.array[vertex + 1] = values[value + 1];
      position.array[vertex + 2] = values[value + 2];
    }
    position.needsUpdate = true;
  }

  if (entry.masks) {
    ensureMaskData(geometry);
    const values = entry.masks[target];
    const masks = geometry.userData.maskWeights;
    for (let i = 0; i < entry.masks.indices.length; i++) masks[entry.masks.indices[i]] = values[i];
    updateMaskColors(geometry);
  }

  geometry.computeVertexNormals();
  smoothNormalsByWeldedGroups(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  markSpatialIndexStale(geometry);
  rebuildCurrentSpatialIndexIfNeeded(geometry);
  markWireframeDirty(rec.mesh);
  selectObject(rec.mesh);
  updateInspector();
  renderObjectList();
}

function applyPaintDelta(entry) {
  const rec = state.recordsById.get(entry.recordId);
  if (!rec) return;
  const source = entry.apply === 'after' ? entry.after : entry.before;
  const patch = new ImageData(new Uint8ClampedArray(source), entry.width, entry.height);
  rec.textureSet.ctx.putImageData(patch, entry.x, entry.y);
  rec.textureSet.texture.needsUpdate = true;
  selectObject(rec.mesh);
  updateInspector();
  renderObjectList();
}

function captureCurrentEntryFor(entry) {
  if (entry.kind === 'geometryDelta' || entry.kind === 'paintDelta') {
    return { ...entry, apply: entry.apply === 'before' ? 'after' : 'before' };
  }
  if (entry.kind === 'object') {
    const rec = state.recordsById.get(entry.recordId);
    if (!rec) return null;
    return {
      kind: 'object',
      label: entry.label,
      recordId: rec.id,
      snapshot: serializeObject(rec, { includeTexture: !!(entry.snapshot?.texture || entry.snapshot?.textureData) })
    };
  }
  if (entry.kind === 'objectBatch') {
    if (entry.action === 'remove') {
      const snapshots = (entry.recordIds || [])
        .map((id) => state.recordsById.get(id))
        .filter(Boolean)
        .map((rec) => serializeObject(rec, { includeTexture: true }));
      return { kind: 'objectBatch', label: entry.label, action: 'restore', snapshots };
    }
    return {
      kind: 'objectBatch',
      label: entry.label,
      action: 'remove',
      recordIds: (entry.snapshots || []).map((snapshot) => snapshot.id)
    };
  }
  return { kind: 'scene', label: entry.label, snapshot: serializeScene(entry.label) };
}

async function restoreHistoryEntry(entry) {
  if (!entry) return;
  if (entry.kind === 'geometryDelta') applyGeometryDelta(entry);
  else if (entry.kind === 'paintDelta') applyPaintDelta(entry);
  else if (entry.kind === 'object') await restoreObjectSnapshot(entry.snapshot);
  else if (entry.kind === 'objectBatch') await restoreObjectBatch(entry);
  else await restoreScene(entry.snapshot, false);
}

async function undo() {
  if (!state.undo.length) return;
  const entry = state.undo.pop();
  state.undoBytes -= entry?.bytes || 0;
  const redoEntry = captureCurrentEntryFor(entry);
  if (redoEntry) addHistoryEntry(redoEntry, state.redo);
  await restoreHistoryEntry(entry);
  updateHistoryButtons();
  setStatus(`Deshacer: ${entry.label}`);
}

async function redo() {
  if (!state.redo.length) return;
  const entry = state.redo.pop();
  state.redoBytes -= entry?.bytes || 0;
  const undoEntry = captureCurrentEntryFor(entry);
  if (undoEntry) addHistoryEntry(undoEntry, state.undo);
  await restoreHistoryEntry(entry);
  trimUndoHistory();
  updateHistoryButtons();
  setStatus(`Rehacer: ${entry.label}`);
}

function updateHistoryButtons() {
  $('undoBtn').disabled = state.undo.length === 0;
  $('redoBtn').disabled = state.redo.length === 0;
}

function drawDataUrlToCanvas(dataUrl, texCanvas, ctx) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, texCanvas.width, texCanvas.height);
      ctx.drawImage(img, 0, 0, texCanvas.width, texCanvas.height);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

function loadTextureFile(file) {
  const rec = getRecord();
  if (!rec || !file) return;
  pushObjectHistory('Cargar textura', state.selected, { includeTexture: true });
  const img = new Image();
  const objectUrl = URL.createObjectURL(file);
  img.onload = () => {
    rec.textureSet.ctx.clearRect(0, 0, rec.textureSet.canvas.width, rec.textureSet.canvas.height);
    rec.textureSet.ctx.drawImage(img, 0, 0, rec.textureSet.canvas.width, rec.textureSet.canvas.height);
    rec.textureSet.texture.needsUpdate = true;
    URL.revokeObjectURL(objectUrl);
    setStatus(`Textura cargada: ${file.name}`);
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    setStatus(`No se pudo cargar la textura: ${file.name}`);
  };
  img.src = objectUrl;
}

function clearTexture() {
  const rec = getRecord();
  if (!rec) return;
  pushObjectHistory('Limpiar textura', state.selected, { includeTexture: true });
  const { canvas, ctx, texture } = rec.textureSet;
  ctx.fillStyle = ui.baseColor.value;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  texture.needsUpdate = true;
}

function clearMask() {
  const mesh = state.selected;
  if (!mesh) return;
  pushObjectHistory('Limpiar máscara');
  const mask = ensureMaskData(mesh.geometry);
  mask.fill(1);
  updateMaskColors(mesh.geometry);
  setStatus('Máscara limpiada');
}

function invertMask() {
  const mesh = state.selected;
  if (!mesh) return;
  pushObjectHistory('Invertir máscara');
  const mask = ensureMaskData(mesh.geometry);
  for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
  updateMaskColors(mesh.geometry);
  setStatus('Máscara invertida');
}

function blurMask() {
  const mesh = state.selected;
  if (!mesh) return;
  pushObjectHistory('Difuminar máscara');
  const geometry = mesh.geometry;
  const mask = ensureMaskData(geometry);
  const topology = getSculptTopology(geometry);
  const next = new Float32Array(mask);
  for (let groupId = 0; groupId < topology.groups.length; groupId++) {
    const group = topology.groups[groupId];
    let sum = getGroupMask(geometry, group);
    let count = 1;
    for (const neighborId of group.neighbors) {
      sum += getGroupMask(geometry, topology.groups[neighborId]);
      count++;
    }
    const averaged = sum / count;
    for (const vertexIndex of group.vertices) next[vertexIndex] = averaged;
  }
  geometry.userData.maskWeights = next;
  updateMaskColors(geometry);
  setStatus('Máscara suavizada');
}

function updateMaterial() {
  const mesh = state.selected;
  const rec = getRecord(mesh);
  if (!mesh || !rec) return;
  const pbr = getPbrMaterial(rec);
  pbr.metalness = parseFloat(ui.metalness.value);
  pbr.roughness = parseFloat(ui.roughness.value);
  pbr.needsUpdate = true;
  if (state.viewMode === 'pbr') mesh.material = pbr;
}

function applyBaseColor() {
  const rec = getRecord();
  if (!rec) return;
  pushObjectHistory('Cambiar color base', state.selected, { includeTexture: true });
  const { canvas, ctx, texture } = rec.textureSet;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = ui.baseColor.value;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  texture.needsUpdate = true;
}

function saveTexture() {
  const rec = getRecord();
  if (!rec) return;
  rec.textureSet.canvas.toBlob((blob) => {
    downloadBlob(blob, `${rec.mesh.name.replace(/\s+/g, '_')}_textura.png`);
  }, 'image/png');
}

function exportOBJ() {
  const exporter = new OBJExporter();
  const group = exportGroup({ selectedOnly: false, includeHidden: true, keepMaterialMap: true });
  const data = exporter.parse(group);
  downloadBlob(new Blob([data], { type: 'text/plain' }), 'sculptcad_pro_scene.obj');
}

function exportGLB() {
  const exporter = new GLTFExporter();
  const group = exportGroup({ selectedOnly: false, includeHidden: true, keepMaterialMap: true });
  exporter.parse(group, (result) => {
    if (result instanceof ArrayBuffer) {
      downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), 'sculptcad_pro_scene.glb');
    } else {
      downloadBlob(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), 'sculptcad_pro_scene.gltf');
    }
  }, (err) => console.error(err), { binary: true, embedImages: true, includeCustomExtensions: false });
}

function exportSTL(selectedOnly = false) {
  if (selectedOnly && !state.selected) {
    setStatus('Selecciona un objeto antes de exportar STL seleccionado');
    return;
  }

  const records = getExportRecords({ selectedOnly, includeHidden: !selectedOnly });
  if (!records.length) {
    setStatus('No hay geometría para exportar STL');
    return;
  }

  const triangles = records.reduce((sum, rec) => sum + geometryStats(rec.mesh.geometry).triangles, 0);
  if (triangles > 250000) {
    const ok = window.confirm(`El STL tendrá aproximadamente ${triangles.toLocaleString()} triángulos. Puede tardar y generar un archivo pesado. ¿Continuar?`);
    if (!ok) return;
  }

  const exporter = new STLExporter();
  const binary = (ui.stlFormat?.value || 'binary') === 'binary';
  const group = exportGroup({ selectedOnly, includeHidden: !selectedOnly, keepMaterialMap: false, stlSafe: true });
  const result = exporter.parse(group, { binary });
  const baseName = selectedOnly && state.selected ? state.selected.name.replace(/\s+/g, '_') : 'sculptcad_pro_scene';

  if (binary) {
    const buffer = result instanceof DataView ? result.buffer : result;
    downloadBlob(new Blob([buffer], { type: 'model/stl' }), `${baseName}.stl`);
  } else {
    downloadBlob(new Blob([result], { type: 'model/stl' }), `${baseName}.stl`);
  }

  setStatus(binary
    ? 'STL binario exportado: solo geometría, sin color ni texturas'
    : 'STL ASCII exportado: solo geometría, sin color ni texturas');
}

function getExportRecords({ selectedOnly = false, includeHidden = true } = {}) {
  if (selectedOnly) {
    const rec = getRecord(state.selected);
    return rec ? [rec] : [];
  }
  return state.objects.filter((rec) => includeHidden || rec.mesh.visible);
}

function sanitizeExportClone(clone, { keepMaterialMap = true, stlSafe = false } = {}) {
  clone.userData = {};
  if (clone.geometry) {
    clone.geometry.userData = {};
    clone.geometry.deleteAttribute?.('color');
    clone.geometry.computeVertexNormals();
    clone.geometry.computeBoundingSphere();
  }
  if (clone.material) {
    clone.material = clone.material.clone();
    clone.material.userData = {};
    clone.material.wireframe = false;
    clone.material.vertexColors = false;
    if (!keepMaterialMap || stlSafe) clone.material.map = null;
    clone.material.needsUpdate = true;
  }
  clone.children.length = 0;
  clone.visible = true;
  return clone;
}

function exportGroup({ selectedOnly = false, includeHidden = true, keepMaterialMap = true, stlSafe = false } = {}) {
  const group = new THREE.Group();
  group.name = selectedOnly ? 'SculptCAD Pro Selected Export' : 'SculptCAD Pro Export';
  for (const rec of getExportRecords({ selectedOnly, includeHidden })) {
    const clone = rec.mesh.clone(false);
    clone.geometry = rec.mesh.geometry.clone();
    clone.material = getPbrMaterial(rec).clone();
    if (keepMaterialMap && !stlSafe) clone.material.map = rec.textureSet.texture;
    sanitizeExportClone(clone, { keepMaterialMap, stlSafe });
    clone.matrix.copy(rec.mesh.matrix);
    clone.matrixWorld.copy(rec.mesh.matrixWorld);
    clone.position.copy(rec.mesh.position);
    clone.quaternion.copy(rec.mesh.quaternion);
    clone.scale.copy(rec.mesh.scale);
    clone.name = rec.mesh.name;
    group.add(clone);
  }
  group.updateMatrixWorld(true);
  return group;
}

function openProjectDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('SculptCADProDB', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveProjectLocal() {
  try {
    const db = await openProjectDB();
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put({ savedAt: Date.now(), scene: serializeScene('autosave') }, 'last');
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    setStatus('Proyecto guardado localmente en IndexedDB');
  } catch (error) {
    console.error(error);
    setStatus('No se pudo guardar el proyecto local');
  }
}

async function loadProjectLocal() {
  try {
    const db = await openProjectDB();
    const tx = db.transaction('projects', 'readonly');
    const request = tx.objectStore('projects').get('last');
    const saved = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!saved?.scene) {
      setStatus('No hay proyecto local guardado');
      return;
    }
    const ok = window.confirm('¿Cargar el último proyecto local? La escena actual será reemplazada.');
    if (!ok) return;
    pushHistory('Cargar proyecto local');
    await restoreScene(saved.scene, false);
    setStatus(`Proyecto local cargado: ${new Date(saved.savedAt).toLocaleString()}`);
  } catch (error) {
    console.error(error);
    setStatus('No se pudo cargar el proyecto local');
  }
}

function applyWireframeToScene(enabled) {
  state.wireframeEnabled = !!enabled;
  state.wireframeDirty.clear();
  for (const rec of state.objects) {
    if (enabled) rebuildRecordWireframe(rec, true);
    else setRecordWireframe(rec, false);
  }
  setStatus(enabled ? 'Wireframe activado: mallado superpuesto sobre el objeto' : 'Wireframe desactivado');
}

function updateShapeInfo(message, isError = false) {
  if (!ui.shapeInfo) return;
  ui.shapeInfo.textContent = message;
  ui.shapeInfo.classList.toggle('shape-info--error', !!isError);
}

function clearPreviewCanvas(canvas, placeholder = 'Sin vista previa') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,.03)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  ctx.fillStyle = 'rgba(190,203,220,.72)';
  ctx.font = '12px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(placeholder, canvas.width / 2, canvas.height / 2);
  canvas.parentElement?.classList.add('is-empty');
}

function renderFittedCanvas(target, sourceCanvas) {
  if (!target || !sourceCanvas) return;
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.fillStyle = 'rgba(4,8,16,.75)';
  ctx.fillRect(0, 0, target.width, target.height);
  const scale = Math.min(target.width / sourceCanvas.width, target.height / sourceCanvas.height);
  const drawW = sourceCanvas.width * scale;
  const drawH = sourceCanvas.height * scale;
  const offsetX = (target.width - drawW) * 0.5;
  const offsetY = (target.height - drawH) * 0.5;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, offsetX, offsetY, drawW, drawH);
  target.parentElement?.classList.remove('is-empty');
}

function buildMaskBounds(mask, width, height) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + 1 > maxX) maxX = x + 1;
      if (y + 1 > maxY) maxY = y + 1;
    }
  }
  if (!count) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, count };
}

function updateShapePreviewBinary(mask, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const on = mask[i] ? 0 : 255;
    const idx = i * 4;
    image.data[idx] = on;
    image.data[idx + 1] = on;
    image.data[idx + 2] = on;
    image.data[idx + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  renderFittedCanvas(ui.shapeBinaryPreview, canvas);
}

function simplifyLoopPoints(loop) {
  if (!Array.isArray(loop) || loop.length < 4) return loop || [];
  const cleaned = [];
  for (const point of loop) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev.x !== point.x || prev.y !== point.y) cleaned.push(point);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first.x === last.x && first.y === last.y) cleaned.pop();
  }
  if (cleaned.length < 3) return cleaned;
  let changed = true;
  while (changed && cleaned.length >= 3) {
    changed = false;
    for (let i = 0; i < cleaned.length; i++) {
      const a = cleaned[(i - 1 + cleaned.length) % cleaned.length];
      const b = cleaned[i];
      const c = cleaned[(i + 1) % cleaned.length];
      const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      if (collinear) {
        cleaned.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return cleaned;
}

function removeSmallMaskComponents(mask, width, height, minArea = 0) {
  if (!mask || minArea <= 1) return mask;
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!next[start] || visited[start]) continue;
      const queue = [start];
      const component = [];
      visited[start] = 1;
      while (queue.length) {
        const idx = queue.pop();
        component.push(idx);
        const cx = idx % width;
        const cy = Math.floor(idx / width);
        for (const [dx, dy] of neighbors) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!next[ni] || visited[ni]) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }
      if (component.length < minArea) {
        for (const idx of component) next[idx] = 0;
      }
    }
  }
  return next;
}

function traceMaskLoops(mask, width, height) {
  const startMap = new Map();
  const edges = [];
  const addEdge = (x1, y1, x2, y2) => {
    const edge = { start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, used: false };
    edges.push(edge);
    const key = `${x1},${y1}`;
    const list = startMap.get(key) || [];
    list.push(edge);
    startMap.set(key, list);
  };
  const filled = (x, y) => x >= 0 && y >= 0 && x < width && y < height && !!mask[y * width + x];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const dirKey = (dx, dy) => `${dx},${dy}`;
  const directionOrder = ['1,0', '0,1', '-1,0', '0,-1'];
  const chooseNextEdge = (candidates, previous) => {
    if (!candidates?.length) return null;
    if (candidates.length === 1 || !previous) return candidates.find((edge) => !edge.used) || null;
    const prevDir = dirKey(previous.end.x - previous.start.x, previous.end.y - previous.start.y);
    const prevIndex = directionOrder.indexOf(prevDir);
    const preference = [1, 0, 3, 2].map((delta) => directionOrder[(prevIndex + delta + 4) % 4]);
    for (const key of preference) {
      const edge = candidates.find((candidate) => !candidate.used && dirKey(candidate.end.x - candidate.start.x, candidate.end.y - candidate.start.y) === key);
      if (edge) return edge;
    }
    return candidates.find((edge) => !edge.used) || null;
  };

  const loops = [];
  for (const edge of edges) {
    if (edge.used) continue;
    const loop = [{ x: edge.start.x, y: edge.start.y }];
    let current = edge;
    let guard = 0;
    while (current && !current.used && guard < edges.length + 10) {
      current.used = true;
      loop.push({ x: current.end.x, y: current.end.y });
      const start = loop[0];
      const end = current.end;
      if (end.x === start.x && end.y === start.y) break;
      current = chooseNextEdge(startMap.get(`${end.x},${end.y}`), current);
      guard++;
    }
    const simplified = simplifyLoopPoints(loop);
    if (simplified.length >= 3) loops.push(simplified);
  }
  return loops;
}

function loopSignedArea(loop) {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function averagePoint(points) {
  const result = new THREE.Vector2();
  for (const point of points) result.add(point);
  return result.multiplyScalar(1 / Math.max(1, points.length));
}

function pointLineDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function simplifyOpenPolyline(points, epsilon) {
  if (!Array.isArray(points) || points.length <= 2 || epsilon <= 0) return points ? points.slice() : [];
  let maxDistance = 0;
  let index = -1;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const distance = pointLineDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance > epsilon && index !== -1) {
    const left = simplifyOpenPolyline(points.slice(0, index + 1), epsilon);
    const right = simplifyOpenPolyline(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function simplifyClosedLoopRDP(points, epsilon) {
  if (!Array.isArray(points) || points.length <= 3 || epsilon <= 0) return points ? points.slice() : [];
  const open = points.concat([points[0]]);
  const simplified = simplifyOpenPolyline(open, epsilon);
  if (simplified.length > 1) simplified.pop();
  return simplifyLoopPoints(simplified);
}

function chaikinSmoothLoop(points, iterations = 0) {
  let current = points ? points.slice() : [];
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 3) break;
    const next = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    current = next;
  }
  return current;
}

function loopPerimeter(loop) {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function resampleLoop(loop, segmentLength = 3) {
  if (!Array.isArray(loop) || loop.length < 3 || segmentLength <= 0) return loop ? loop.slice() : [];
  const perimeter = loopPerimeter(loop);
  if (perimeter <= 0) return loop.slice();
  const count = Math.max(12, Math.min(600, Math.round(perimeter / segmentLength)));
  const cumulative = [0];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    cumulative.push(cumulative[cumulative.length - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cumulative[cumulative.length - 1];
  const samples = [];
  for (let s = 0; s < count; s++) {
    const target = (s / count) * total;
    let edgeIndex = 0;
    while (edgeIndex < loop.length && cumulative[edgeIndex + 1] < target) edgeIndex++;
    const edgeStart = cumulative[edgeIndex];
    const edgeEnd = cumulative[edgeIndex + 1];
    const a = loop[edgeIndex % loop.length];
    const b = loop[(edgeIndex + 1) % loop.length];
    const t = edgeEnd > edgeStart ? (target - edgeStart) / (edgeEnd - edgeStart) : 0;
    samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return samples;
}

function processRasterLoops(rawLoops, width, height) {
  if (!rawLoops?.length) return [];
  const simplifyAmount = Number(ui.shapeSimplify?.value || 0) / 100;
  const smoothAmount = Number(ui.shapeSmoothness?.value || 0) / 100;
  const minDimension = Math.max(1, Math.min(width, height));
  const epsilon = simplifyAmount * (minDimension * 0.05);
  const resampleStep = THREE.MathUtils.lerp(1.2, 4.5, smoothAmount);
  const smoothIterations = Math.max(0, Math.round(smoothAmount * 4));

  return rawLoops.map((loop) => {
    let next = simplifyLoopPoints(loop);
    if (epsilon > 0.01) next = simplifyClosedLoopRDP(next, epsilon);
    if (smoothAmount > 0.001) {
      next = resampleLoop(next, resampleStep);
      next = chaikinSmoothLoop(next, smoothIterations);
      if (epsilon > 0.01) next = simplifyClosedLoopRDP(next, epsilon * 0.45);
    }
    return simplifyLoopPoints(next);
  }).filter((loop) => loop.length >= 3 && Math.abs(loopSignedArea(loop)) >= 1);
}

function smoothMask(mask, width, height, strength = 0) {
  const passes = Math.max(0, Math.round((strength / 100) * 3));
  if (!mask || passes <= 0) return mask;
  let current = new Uint8Array(mask);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let samples = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            sum += current[ny * width + nx];
            samples++;
          }
        }
        next[y * width + x] = sum >= Math.ceil(samples * 0.5) ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

function rasterLoopsToSvg(loops, width, height) {
  if (!loops.length) return '';
  const pathData = loops.map((loop) => loop.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ') + ' Z').join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <path d="${pathData}" fill="#000" fill-rule="evenodd"/>
</svg>`;
}

function updateShapePreviewVector(loops, width, height) {
  const canvas = ui.shapeVectorPreview;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(4,8,16,.75)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!loops.length) {
    clearPreviewCanvas(canvas, 'Sin vector');
    return;
  }
  const scale = Math.min(canvas.width / width, canvas.height / height);
  const offsetX = (canvas.width - width * scale) * 0.5;
  const offsetY = (canvas.height - height * scale) * 0.5;
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.fillStyle = 'rgba(70,229,255,.22)';
  ctx.strokeStyle = 'rgba(70,229,255,.95)';
  ctx.lineWidth = Math.max(1 / scale, 0.75);
  ctx.beginPath();
  for (const loop of loops) {
    if (!loop.length) continue;
    ctx.moveTo(loop[0].x, loop[0].y);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
    ctx.closePath();
  }
  ctx.fill('evenodd');
  ctx.stroke();
  ctx.restore();
  canvas.parentElement?.classList.remove('is-empty');
}

function syncShapeAspect(changed = 'width') {
  if (!ui.shapeLockAspect?.checked || !rasterVectorState.aspect || !Number.isFinite(rasterVectorState.aspect)) return;
  const aspect = rasterVectorState.aspect;
  if (changed === 'width') {
    const widthValue = Math.max(0.1, Number(ui.shapeWidth.value) || 50);
    ui.shapeHeight.value = (widthValue / aspect).toFixed(2);
  } else if (changed === 'height') {
    const heightValue = Math.max(0.1, Number(ui.shapeHeight.value) || 50);
    ui.shapeWidth.value = (heightValue * aspect).toFixed(2);
  }
}

function refreshRasterVectorFromControls() {
  if (!rasterVectorState.sourceCanvas.width || !rasterVectorState.sourceCanvas.height) {
    updateShapeInfo('Carga una silueta en blanco y negro para generar el contorno vectorial.');
    clearPreviewCanvas(ui.shapeBinaryPreview, 'Silueta');
    clearPreviewCanvas(ui.shapeVectorPreview, 'Vector');
    if (ui.shapeDownloadSvgBtn) ui.shapeDownloadSvgBtn.disabled = true;
    if (ui.shapeGenerateBtn) ui.shapeGenerateBtn.disabled = true;
    rasterVectorState.mask = null;
    rasterVectorState.rawLoops = [];
    rasterVectorState.loops = [];
    rasterVectorState.svg = '';
    rasterVectorState.bounds = null;
    return;
  }

  const { width, height } = rasterVectorState.sourceCanvas;
  const image = rasterVectorState.sourceCtx.getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  const threshold = Number(ui.shapeThreshold?.value || 128);
  const invert = !!ui.shapeInvert?.checked;
  const noiseArea = Number(ui.shapeNoiseArea?.value || 0);
  const smoothStrength = Number(ui.shapeSmoothness?.value || 0);

  for (let i = 0; i < mask.length; i++) {
    const idx = i * 4;
    const r = image.data[idx];
    const g = image.data[idx + 1];
    const b = image.data[idx + 2];
    const a = image.data[idx + 3] / 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const effective = luminance * a + 255 * (1 - a);
    const filled = invert ? effective >= threshold : effective < threshold;
    mask[i] = filled ? 1 : 0;
  }

  const denoised = removeSmallMaskComponents(mask, width, height, noiseArea);
  const cleaned = smoothMask(denoised, width, height, smoothStrength);
  const rawLoops = traceMaskLoops(cleaned, width, height);
  const loops = processRasterLoops(rawLoops, width, height);
  const bounds = buildMaskBounds(cleaned, width, height);
  rasterVectorState.mask = cleaned;
  rasterVectorState.width = width;
  rasterVectorState.height = height;
  rasterVectorState.rawLoops = rawLoops;
  rasterVectorState.loops = loops;
  rasterVectorState.svg = rasterLoopsToSvg(loops, width, height);
  rasterVectorState.bounds = bounds;
  rasterVectorState.aspect = bounds ? bounds.width / Math.max(1e-6, bounds.height) : rasterVectorState.aspect;

  updateShapePreviewBinary(cleaned, width, height);
  updateShapePreviewVector(loops, width, height);
  if (ui.shapeDownloadSvgBtn) ui.shapeDownloadSvgBtn.disabled = !loops.length;
  if (ui.shapeGenerateBtn) ui.shapeGenerateBtn.disabled = !loops.length;

  if (!bounds || !loops.length) {
    updateShapeInfo('No se encontraron contornos útiles. Ajusta el umbral o invierte la figura.', true);
    return;
  }
  updateShapeInfo(`Vector listo: ${loops.length} contorno(s), área útil ${bounds.width}×${bounds.height} px, suavizado ${Math.round(smoothStrength)}%.`);
}

function loadShapeImageFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    updateShapeInfo('Formato no compatible. Usa PNG, JPG, WEBP, BMP o GIF.', true);
    setStatus('Formato de imagen no compatible para 2D → 3D');
    return;
  }
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const width = Math.max(4, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(4, Math.round((img.naturalHeight || img.height) * scale));
    rasterVectorState.sourceCanvas.width = width;
    rasterVectorState.sourceCanvas.height = height;
    rasterVectorState.sourceCtx.clearRect(0, 0, width, height);
    rasterVectorState.sourceCtx.drawImage(img, 0, 0, width, height);
    rasterVectorState.sourceName = file.name.replace(/\.[^.]+$/, '');
    rasterVectorState.aspect = width / Math.max(1, height);
    ui.shapeWidth.value = '50';
    ui.shapeHeight.value = (50 / rasterVectorState.aspect).toFixed(2);
    renderFittedCanvas(ui.shapeSourcePreview, rasterVectorState.sourceCanvas);
    refreshRasterVectorFromControls();
    setWorkspace('model', { syncTool: false, scroll: false });
    setStatus(`Imagen cargada para 2D → 3D: ${file.name}`);
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    updateShapeInfo('No se pudo leer la imagen.', true);
    setStatus(`No se pudo abrir ${file.name}`);
  };
  img.src = objectUrl;
}

function downloadCurrentShapeSvg() {
  if (!rasterVectorState.svg) {
    setStatus('Genera primero un contorno vectorial.');
    return;
  }
  downloadBlob(new Blob([rasterVectorState.svg], { type: 'image/svg+xml;charset=utf-8' }), `${rasterVectorState.sourceName || 'silueta'}_vector.svg`);
  setStatus('SVG generado descargado');
}

function buildExtrudeShapesFromRaster() {
  const loops = rasterVectorState.loops || [];
  const bounds = rasterVectorState.bounds;
  if (!loops.length || !bounds) return [];
  const targetWidth = Math.max(0.1, Number(ui.shapeWidth?.value || 50));
  const targetHeight = Math.max(0.1, Number(ui.shapeHeight?.value || (targetWidth / Math.max(1e-6, rasterVectorState.aspect))));
  const scaleX = targetWidth / Math.max(1e-6, bounds.width);
  const scaleY = targetHeight / Math.max(1e-6, bounds.height);

  const transformed = loops.map((loop) => {
    const points = loop.map((point) => new THREE.Vector2((point.x - bounds.minX) * scaleX, (bounds.maxY - point.y) * scaleY));
    const area = loopSignedArea(loop);
    return { points, area };
  }).filter((entry) => entry.points.length >= 3);

  const outers = [];
  const holes = [];
  for (const entry of transformed) {
    const areaYUp = loopSignedArea(entry.points);
    if (entry.area >= 0) {
      if (areaYUp < 0) entry.points.reverse();
      outers.push(entry);
    } else {
      if (areaYUp > 0) entry.points.reverse();
      holes.push(entry);
    }
  }

  const shapes = outers.map((outer) => ({ shape: new THREE.Shape(outer.points), points: outer.points }));
  for (const hole of holes) {
    const test = averagePoint(hole.points);
    const parent = shapes.find((entry) => pointInPolygon(test, entry.points));
    if (parent) parent.shape.holes.push(new THREE.Path(hole.points));
  }
  return shapes.map((entry) => entry.shape);
}

function createExtrudedShapeObject() {
  if (!rasterVectorState.loops?.length) {
    updateShapeInfo('No hay contornos para extruir todavía.', true);
    return;
  }
  try {
    const shapes = buildExtrudeShapesFromRaster();
    if (!shapes.length) {
      updateShapeInfo('No se pudo construir la forma vectorial a partir de la imagen.', true);
      return;
    }
    const bevel = Math.max(0, Number(ui.shapeBevel?.value || 0));
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: Math.max(0.1, Number(ui.shapeDepth?.value || 4)),
      bevelEnabled: bevel > 0.0001,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelSegments: bevel > 0 ? 2 : 0,
      curveSegments: Math.max(8, Math.round(8 + Number(ui.shapeSmoothness?.value || 0) * 0.12)),
      steps: 1
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.computeVertexNormals();
    const record = addImportedMesh(geometry, `${rasterVectorState.sourceName || 'Silueta'} 3D`, 'image-extrude');
    geometry.dispose?.();
    if (record) {
      pushObjectsAdded('Crear objeto desde imagen', [record]);
      selectObject(record.mesh);
      frameSelection();
      setStatus(`Objeto 3D creado desde ${rasterVectorState.sourceName || 'la imagen'}`);
    }
  } catch (error) {
    console.error(error);
    updateShapeInfo('No se pudo extruir el contorno. Prueba con una silueta más limpia.', true);
    setStatus('Error al crear el objeto 3D desde la imagen');
  }
}

function importModelFile(file) {
  if (!file) return;
  const ext = file.name.toLowerCase().split('.').pop();
  const baseName = file.name.replace(/\.(obj|stl|gltf|glb)$/i, '');
  const reader = new FileReader();
  reader.onerror = () => setStatus(`No se pudo leer ${file.name}`);
  reader.onload = () => {
    try {
      if (ext === 'obj') {
        const loaded = new OBJLoader().parse(reader.result);
        importThreeObject(loaded, baseName);
      } else if (ext === 'stl') {
        const geo = new STLLoader().parse(reader.result);
        const rec = addImportedMesh(geo, baseName, 'imported');
        if (rec) pushObjectsAdded('Importar modelo', [rec]);
      } else if (ext === 'gltf' || ext === 'glb') {
        new GLTFLoader().parse(reader.result, '', (gltf) => {
          importThreeObject(gltf.scene, baseName);
          setStatus(`Modelo importado: ${file.name}`);
        }, (error) => {
          console.error(error);
          setStatus(`Error al importar ${file.name}`);
        });
      } else {
        setStatus(`Formato no soportado: .${ext}`);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error al importar ${file.name}`);
    }
  };
  if (ext === 'obj' || ext === 'gltf') reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

function importThreeObject(root, baseName) {
  root.updateMatrixWorld(true);
  const parts = [];
  let count = 0;
  const combinedBox = new THREE.Box3();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
    const geometry = child.geometry.clone();
    // Conserva jerarquías y transformaciones anidadas de OBJ/GLTF convirtiendo
    // cada parte a coordenadas comunes antes de separarla en objetos editables.
    geometry.applyMatrix4(child.matrixWorld);
    geometry.computeBoundingBox();
    if (geometry.boundingBox) combinedBox.union(geometry.boundingBox);
    parts.push({ geometry, name: child.name || `${baseName}_${++count}` });
  });

  if (!parts.length) {
    setStatus('El archivo no contiene mallas editables.');
    return;
  }

  const center = combinedBox.getCenter(new THREE.Vector3());
  const offset = new THREE.Matrix4().makeTranslation(-center.x, -combinedBox.min.y, -center.z);
  const importedRecords = [];
  for (const part of parts) {
    part.geometry.applyMatrix4(offset);
    const rec = addImportedMesh(part.geometry, part.name, 'imported', { preservePlacement: true, autoSelect: false });
    if (rec) importedRecords.push(rec);
    part.geometry.dispose?.();
  }

  const last = importedRecords.at(-1);
  if (last) {
    selectObject(last.mesh);
    frameSelection();
  }
  renderObjectList();
  if (importedRecords.length) pushObjectsAdded('Importar modelo', importedRecords);
  setStatus(`${formatCount(importedRecords.length)} pieza(s) importada(s): ${baseName}`);
}

function addImportedMesh(geometry, name, type = 'imported', options = {}) {
  const textureSet = makeTextureCanvas(ui.baseColor.value);
  const source = geometry.clone();
  if (!options.preservePlacement) source.center();
  const geo = prepareGeometry(source);
  source.dispose?.();
  const mesh = new THREE.Mesh(geo, createMaterial(textureSet));
  mesh.name = name || `Importado ${state.idCounter}`;
  if (!options.preservePlacement) {
    geo.computeBoundingBox();
    if (geo.boundingBox) mesh.position.y = -geo.boundingBox.min.y;
  }
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  const record = { id: state.idCounter++, type, mesh, textureSet, pbrMaterial: mesh.material, matcapMaterials: new Map(), createdAt: Date.now() };
  mesh.userData.recordId = record.id;
  scene.add(mesh);
  state.objects.push(record);
  registerRecord(record);
  if (options.autoSelect !== false) selectObject(mesh);
  renderObjectList();
  return record;
}

function keyboard(event) {
  const active = document.activeElement;
  const editing = active && (['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable);
  if (editing) return;

  const lower = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (mod && lower === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && lower === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelected();
    return;
  }
  if (event.key === 'Escape') {
    if (ui.helpDialog?.open) ui.helpDialog.close();
    if (state.measureStart) {
      state.measureStart = null;
      if (state.measureLine) {
        scene.remove(state.measureLine);
        state.measureLine.geometry?.dispose?.();
        state.measureLine.material?.dispose?.();
        state.measureLine = null;
      }
      setStatus('Medición cancelada');
    }
    return;
  }
  if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
    event.preventDefault();
    ui.helpDialog?.showModal?.();
    return;
  }
  if (lower === 'f') {
    event.preventDefault();
    frameSelection();
    return;
  }
  if (lower === 'n' && ui.negative) {
    ui.negative.checked = !ui.negative.checked;
    setStatus(`Invertir dirección: ${ui.negative.checked ? 'activado' : 'desactivado'}`);
    return;
  }
  const workspaceMap = { '1': 'model', '2': 'sculpt', '3': 'paint', '4': 'export' };
  if (workspaceMap[event.key]) {
    setWorkspace(workspaceMap[event.key]);
    return;
  }
  const keyMap = { v: 'select', w: 'move', e: 'rotate', r: 'scale', b: 'sculpt', p: 'paint', m: 'measure' };
  const tool = keyMap[lower];
  if (tool) {
    event.preventDefault();
    setTool(tool);
  }
}

let resizeRaf = 0;

function resize() {
  const rect = viewport.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || window.innerWidth));
  const topbarHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar')) || 72;
  const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || window.innerHeight - topbarHeight));

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function requestViewportResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    resize();
  });
}

function scheduleViewportResize() {
  requestViewportResize();
  // Cubren el arranque, el medio y el cierre de la transición de 220 ms.
  [40, 90, 150, 230, 280].forEach((delay) => setTimeout(requestViewportResize, delay));
}

function animate() {
  requestAnimationFrame(animate);
  orbit.update();

  // ── RAF batching ──────────────────────────────────────────────────────────
  // Procesa máximo un evento de escultura/pintura/cursor por frame.
  // pointermove puede dispararse a 120+ Hz; sin batching, cada evento dispara
  // raycasting y/o la pipeline completa (topology traversal → relaxación) antes
  // de que el browser pueda renderizar, acumulando lag visible.
  if (pendingSculptEvent && state.isPointerDown) {
    const ev = pendingSculptEvent;
    pendingSculptEvent = null;
    applySculptAtEvent(ev);
  }
  if (pendingPaintEvent && state.isPointerDown) {
    const ev = pendingPaintEvent;
    pendingPaintEvent = null;
    applyPaintAtEvent(ev);
  }
  if (pendingCursorEvent) {
    const ev = pendingCursorEvent;
    pendingCursorEvent = null;
    updateBrushVisual(ev);
  }

  // ── Deferred geometry update ──────────────────────────────────────────────
  // Recomputa normales/bounds una sola vez por frame para todos los meshes
  // modificados (puede ser varios si hay simetría activa).
  // Patrón idéntico al render loop de SculptGL.
  flushSculptDirtyMeshes();
  flushWireframeUpdates();
  renderer.render(scene, camera);
}

// ── Secciones del inspector colapsables ──────────────────────────────────────
// Cada <section data-section="..."> guarda su estado en localStorage.
// Un click en el <h2> alterna el colapso; Enter y Space también funcionan
// para accesibilidad de teclado básica.
function initCollapsiblePanels() {
  document.querySelectorAll('.panel[data-section]').forEach((panel) => {
    const h2 = panel.querySelector('h2');
    if (!h2) return;
    const key = `scp-panel-${panel.dataset.section}`;
    // Restaurar estado previo; si no existe preferencia, conserva el estado inicial del HTML.
    const storedPanelState = localStorage.getItem(key);
    if (storedPanelState === '1') panel.classList.add('panel--collapsed');
    else if (storedPanelState === '0') panel.classList.remove('panel--collapsed');
    // Hacer el h2 interactivo
    h2.setAttribute('role', 'button');
    h2.setAttribute('tabindex', '0');
    h2.setAttribute('aria-expanded', panel.classList.contains('panel--collapsed') ? 'false' : 'true');
    h2.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('panel--collapsed');
      h2.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
    });
    h2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h2.click(); }
    });
  });
}

function updateSculptToolOptions() {
  const mode = ui.sculptMode?.value;
  if (ui.smoothToolOptions) ui.smoothToolOptions.hidden = mode !== 'smooth';
  if (ui.creaseToolOptions) ui.creaseToolOptions.hidden = mode !== 'crease';
  document.querySelectorAll('[data-sculpt-modes]').forEach((control) => {
    const modes = (control.dataset.sculptModes || '').split(',').map((item) => item.trim());
    control.hidden = !modes.includes(mode);
  });
}

function updateDependentControls() {
  if (ui.gridSize && ui.snapGrid) ui.gridSize.disabled = !ui.snapGrid.checked;
  if (ui.dynamicTopoEdge && ui.dynamicTopology) ui.dynamicTopoEdge.disabled = !ui.dynamicTopology.checked;
}

function bindUI() {
  document.querySelectorAll('.tool').forEach((btn) => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
  document.querySelectorAll('[data-workspace-btn]').forEach((btn) => btn.addEventListener('click', () => setWorkspace(btn.dataset.workspaceBtn)));
  document.querySelectorAll('[data-primitive]').forEach((btn) => btn.addEventListener('click', () => {
    setWorkspace('model', { syncTool: false, scroll: false });
    addPrimitive(btn.dataset.primitive);
  }));

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', requestViewportResize);
  viewport.addEventListener('transitionend', (event) => {
    if (event.propertyName === 'right' || event.propertyName === 'width' || event.propertyName === 'inset') requestViewportResize();
  });
  if ('ResizeObserver' in window) {
    const viewportObserver = new ResizeObserver(() => requestViewportResize());
    viewportObserver.observe(viewport);
  }
  window.addEventListener('keydown', keyboard);

  ui.objectName.addEventListener('change', () => {
    if (!state.selected) return;
    pushObjectHistory('Renombrar objeto');
    state.selected.name = ui.objectName.value.trim() || state.selected.name;
    renderObjectList();
    updateInspector();
  });
  ui.dimX.addEventListener('change', () => applyDimensions('x'));
  ui.dimY.addEventListener('change', () => applyDimensions('y'));
  ui.dimZ.addEventListener('change', () => applyDimensions('z'));
  ui.textureInput.addEventListener('change', (event) => {
    loadTextureFile(event.target.files[0]);
    event.target.value = '';
  });
  ui.modelInput.addEventListener('change', (event) => {
    importModelFile(event.target.files[0]);
    event.target.value = '';
  });
  ui.shapeImageInput?.addEventListener('change', (event) => {
    loadShapeImageFile(event.target.files?.[0]);
    event.target.value = '';
  });
  [ui.shapeThreshold, ui.shapeNoiseArea, ui.shapeSmoothness, ui.shapeSimplify, ui.shapeBevel].forEach((control) => control?.addEventListener('input', () => {
    updateRangeOutputs();
    if (control !== ui.shapeBevel) refreshRasterVectorFromControls();
  }));
  ui.shapeInvert?.addEventListener('change', refreshRasterVectorFromControls);
  ui.shapeRefreshBtn?.addEventListener('click', refreshRasterVectorFromControls);
  ui.shapeGenerateBtn?.addEventListener('click', createExtrudedShapeObject);
  ui.shapeDownloadSvgBtn?.addEventListener('click', downloadCurrentShapeSvg);
  ui.shapeWidth?.addEventListener('change', () => syncShapeAspect('width'));
  ui.shapeHeight?.addEventListener('change', () => syncShapeAspect('height'));
  ui.shapeLockAspect?.addEventListener('change', () => syncShapeAspect('width'));

  [ui.brushRadius, ui.brushStrength, ui.creasePinch, ui.creaseDepth, ui.dynamicTopoEdge, ui.paintRadius, ui.paintOpacity].forEach((control) => {
    control?.addEventListener('input', updateRangeOutputs);
  });
  ui.metalness.addEventListener('input', () => { updateMaterial(); updateRangeOutputs(); });
  ui.roughness.addEventListener('input', () => { updateMaterial(); updateRangeOutputs(); });
  ui.baseColor.addEventListener('change', applyBaseColor);
  ui.viewMode?.addEventListener('change', () => applyViewModeToScene(ui.viewMode.value));
  ui.snapGrid?.addEventListener('change', updateDependentControls);
  ui.dynamicTopology?.addEventListener('change', updateDependentControls);

  const closeExportMenu = () => document.querySelector('.export-menu')?.removeAttribute('open');
  on('duplicateBtn', 'click', duplicateSelected);
  on('deleteBtn', 'click', deleteSelected);
  on('undoBtn', 'click', undo);
  on('redoBtn', 'click', redo);
  on('newSceneBtn', 'click', clearScene);
  on('clearTextureBtn', 'click', clearTexture);
  on('saveTextureBtn', 'click', () => { saveTexture(); closeExportMenu(); });
  on('saveTexturePanelBtn', 'click', saveTexture);
  on('exportObjBtn', 'click', () => { exportOBJ(); closeExportMenu(); });
  on('exportObjPanelBtn', 'click', exportOBJ);
  on('exportGlbBtn', 'click', () => { exportGLB(); closeExportMenu(); });
  on('exportGlbPanelBtn', 'click', exportGLB);
  on('exportStlSelectedBtn', 'click', () => exportSTL(true));
  on('exportStlSceneBtn', 'click', () => exportSTL(false));
  on('exportStlSelectedQuickBtn', 'click', () => { exportSTL(true); closeExportMenu(); });
  on('exportStlSceneQuickBtn', 'click', () => { exportSTL(false); closeExportMenu(); });
  on('saveLocalBtn', 'click', saveProjectLocal);
  on('saveLocalTopBtn', 'click', saveProjectLocal);
  on('loadLocalBtn', 'click', loadProjectLocal);
  on('centerObjectBtn', 'click', centerSelected);
  on('focusBtn', 'click', frameSelection);
  on('focusQuickBtn', 'click', frameSelection);
  on('clearMaskBtn', 'click', clearMask);
  on('invertMaskBtn', 'click', invertMask);
  on('blurMaskBtn', 'click', blurMask);
  on('subdivideMeshBtn', 'click', subdivideSelectedMesh);
  on('softRemeshBtn', 'click', softRemeshSelectedMesh);
  on('reduceMeshBtn', 'click', reduceSelectedMesh);
  on('relaxMeshBtn', 'click', relaxSelectedMesh);
  on('inspectorToggle', 'click', () => setInspectorCollapsed(!document.body.classList.contains('inspector-collapsed')));
  on('helpBtn', 'click', () => ui.helpDialog?.showModal?.());
  ui.helpDialog?.addEventListener('click', (event) => {
    if (event.target === ui.helpDialog) ui.helpDialog.close();
  });
  ui.wireframeToggle?.addEventListener('change', () => applyWireframeToScene(ui.wireframeToggle.checked));
  ui.sculptMode.addEventListener('change', () => {
    updateSculptToolOptions();
    const labels = {
      masking: 'Proteger zona: pinta áreas bloqueadas; Alt o N recupera la edición',
      transform: 'Transformar objeto: usa W, E o R para mover, rotar o escalar',
      smooth: 'Suavizar superficie: elimina relieve; Shift lo activa temporalmente con cualquier pincel',
      crease: 'Crease: crea un surco; Alt o N lo convierte en una cresta',
      moveSurface: 'Mover zona: arrastra la región capturada al iniciar el trazo'
    };
    setStatus(labels[ui.sculptMode.value] || `Pincel: ${ui.sculptMode.options[ui.sculptMode.selectedIndex].text}`);
  });

  initCollapsiblePanels();
  updateSculptToolOptions();
  updateDependentControls();
  updateRangeOutputs();
  clearPreviewCanvas(ui.shapeSourcePreview, 'Original');
  clearPreviewCanvas(ui.shapeBinaryPreview, 'Silueta');
  clearPreviewCanvas(ui.shapeVectorPreview, 'Vector');
  if (ui.shapeGenerateBtn) ui.shapeGenerateBtn.disabled = true;
  if (ui.shapeDownloadSvgBtn) ui.shapeDownloadSvgBtn.disabled = true;
}


bindUI();
state.wireframeEnabled = !!ui.wireframeToggle?.checked;
addPrimitive('sphere', { skipHistory: true });
let initialWorkspace = 'model';
try { initialWorkspace = localStorage.getItem('scp-workspace') || 'model'; } catch {}
setWorkspace(initialWorkspace, { scroll: false });
if (window.innerWidth <= 820) setInspectorCollapsed(true);
else setInspectorCollapsed(false);
resize();
updateHistoryButtons();
updateInspector();
// Reencuadre diferido: evita que la esfera inicial quede fuera de vista cuando
// el navegador todavía no terminó de calcular el tamaño del viewport.
requestAnimationFrame(() => {
  resize();
  frameSelection();
  window.setTimeout(hideStartupSplash, 180);
});
animate();
