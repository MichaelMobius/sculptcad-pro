import * as THREE from 'three';

export function cloneTypedArray(array) {
  return array && array.slice ? array.slice(0) : Array.from(array || []);
}

export function setIndexAttribute(geometry, indexData) {
  if (!indexData) return;
  if (Array.isArray(indexData)) {
    geometry.setIndex(indexData);
    return;
  }
  geometry.setIndex(new THREE.BufferAttribute(indexData, 1));
}
