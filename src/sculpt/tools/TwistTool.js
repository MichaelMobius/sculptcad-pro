export function applyTwistTool(worldPos, item, ctx) {
  const { THREE, twistAngle, twistAxis, planePoint, negative } = ctx;
  if (Math.abs(twistAngle) <= 1e-5 || item.effectiveFalloff <= 0) return false;

  // SculptGL rota alrededor del eje de vista capturado al iniciar el twist.
  // Usar la normal del hit hacía que el giro cambiara al pasar por zonas curvas.
  const axis = (twistAxis || new THREE.Vector3(0, 0, 1)).clone().normalize();
  const angle = twistAngle * item.effectiveFalloff * (negative ? -1 : 1);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  worldPos.sub(planePoint).applyQuaternion(q).add(planePoint);
  return true;
}
