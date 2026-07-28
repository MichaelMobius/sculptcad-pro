export function applySmoothTool(worldPos, item, ctx) {
  const {
    mesh,
    topology,
    smoothStrength,
    computeNeighborAverageWorld,
    THREE,
    smoothPreserveVolume = true,
    smoothTangent = false
  } = ctx;

  const falloff = item.effectiveFalloff;
  if (falloff <= 0) return false;

  const average = computeNeighborAverageWorld(mesh, topology, item.groupId, new THREE.Vector3());
  const delta = average.sub(worldPos);
  const alpha = Math.min(0.92, falloff * smoothStrength);
  if (alpha <= 0 || delta.lengthSq() <= 1e-18) return false;

  const normal = item.normal.clone().normalize();
  const normalAmount = delta.dot(normal);

  if (smoothTangent) {
    // Equivalente conceptual al modo tangent de SculptGL: elimina ruido lateral
    // sin desplazar la superficie a lo largo de su normal. Es deliberadamente
    // sutil y ya no depende del interruptor global "Modo arcilla".
    delta.addScaledVector(normal, -normalAmount);
  } else if (smoothPreserveVolume && normalAmount < 0) {
    // El Laplaciano puro tiende a encoger superficies convexas. Conservamos una
    // parte del componente normal hacia dentro, pero no lo anulamos: así sí
    // desaparecen bultos y picos, a diferencia del antiguo modo tangencial.
    delta.addScaledVector(normal, -normalAmount * 0.28);
  }

  worldPos.addScaledVector(delta, alpha);
  return true;
}
