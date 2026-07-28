import * as THREE from 'three';

export function disposeWireframeOverlay(record) {
  const overlay = record?.wireframeOverlay;
  if (!overlay) return;
  overlay.parent?.remove?.(overlay);
  overlay.geometry?.dispose?.();
  overlay.material?.dispose?.();
  record.wireframeOverlay = null;
}

export function createWireframeOverlay(geometry) {
  const wireGeometry = new THREE.WireframeGeometry(geometry);
  const wireMaterial = new THREE.LineBasicMaterial({
    color: 0x182235,
    transparent: true,
    opacity: 0.72,
    depthTest: true,
    depthWrite: false
  });
  const overlay = new THREE.LineSegments(wireGeometry, wireMaterial);
  overlay.name = '__wireframe_overlay__';
  overlay.renderOrder = 60;
  overlay.frustumCulled = false;
  overlay.raycast = () => {};
  overlay.scale.setScalar(1.0018);
  return overlay;
}

export function setRecordWireframe(record, enabled) {
  if (!record?.mesh) return;
  // Overlay real: mantiene material/textura y superpone el mallado.
  record.mesh.material.wireframe = false;
  record.mesh.material.needsUpdate = true;
  if (!enabled) {
    if (record.wireframeOverlay) record.wireframeOverlay.visible = false;
    return;
  }
  if (!record.wireframeOverlay) {
    record.wireframeOverlay = createWireframeOverlay(record.mesh.geometry);
    record.mesh.add(record.wireframeOverlay);
  }
  record.wireframeOverlay.visible = record.mesh.visible !== false;
}

export function rebuildRecordWireframe(record, enabled) {
  disposeWireframeOverlay(record);
  if (enabled) setRecordWireframe(record, true);
}
