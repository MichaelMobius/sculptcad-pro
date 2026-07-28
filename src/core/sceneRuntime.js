import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export function createSceneRuntime({
  canvas,
  onTransformDraggingChanged,
  onTransformMouseDown,
  onTransformMouseUp,
  onTransformObjectChange
}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070914);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 200);
  camera.position.set(3.9, 3.1, 4.8);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;

  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 0.25, 0);
  orbit.enableZoom = true;
  orbit.zoomSpeed = 0.9;
  orbit.enablePan = true;
  orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  const transform = new TransformControls(camera, renderer.domElement);
  transform.setSpace('world');
  transform.addEventListener('dragging-changed', onTransformDraggingChanged);
  transform.addEventListener('mouseDown', onTransformMouseDown);
  transform.addEventListener('mouseUp', onTransformMouseUp);
  transform.addEventListener('objectChange', onTransformObjectChange);
  scene.add(transform);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const grid = new THREE.GridHelper(12, 48, 0x29435a, 0x142437);
  grid.position.y = -0.001;
  scene.add(grid);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.18 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.002;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(new THREE.HemisphereLight(0xf7fbff, 0x4a3f3a, 2.05));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 25;
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -8;
  key.shadow.normalBias = 0.035;
  key.shadow.bias = -0.00003;
  scene.add(key);

  const cameraLight = new THREE.PointLight(0xffffff, 3.15, 28, 1.2);
  cameraLight.position.set(0, 0, 0);
  camera.add(cameraLight);
  scene.add(camera);

  const rim = new THREE.DirectionalLight(0x46e5ff, 1.5);
  rim.position.set(-4, 3, -2);
  scene.add(rim);

  const brushRing = new THREE.Mesh(
    new THREE.RingGeometry(0.982, 1.0, 128),
    new THREE.MeshBasicMaterial({ color: 0xff1f35, transparent: true, opacity: 0.98, side: THREE.DoubleSide, depthTest: false })
  );
  brushRing.visible = false;
  brushRing.renderOrder = 999;
  scene.add(brushRing);

  const brushDot = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xff1f35, transparent: true, opacity: 1.0, depthTest: false })
  );
  brushDot.visible = false;
  brushDot.renderOrder = 1000;
  scene.add(brushDot);

  return { scene, camera, renderer, orbit, transform, raycaster, pointer, brushRing, brushDot };
}
