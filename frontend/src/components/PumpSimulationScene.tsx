import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Box, Rotate3D } from 'lucide-react';
import {
  PARTS_COLLECTION_MODEL_URL,
  PUMP_MODEL_URL,
  SIMULATION_PARTS,
} from '../lib/simulation-parts';
import './pump-simulation-scene.css';

interface PumpSimulationSceneProps {
  hasSignal: boolean;
  selectedPartId: string | null;
  onSelectPart: (partId: string) => void;
  onPartHover?: (partId: string | null) => void;
  viewMode?: 'pump' | 'parts';
}

interface Viewport {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

/** 공유된 geometry·material은 마지막에 한 번씩만 해제한다. */
function disposeModel(model: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();

  const materials = new Set<THREE.Material>();

  const textures = new Set<THREE.Texture>();

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

/** 부품마다 다른 원점과 단위를 화면 크기에 맞춘다. 원본 GLB는 수정하지 않는다. */
function centerModel(model: THREE.Object3D, size: number) {
  const bounds = new THREE.Box3().setFromObject(model);

  const dimensions = bounds.getSize(new THREE.Vector3());

  const center = bounds.getCenter(new THREE.Vector3());

  const longestSide = Math.max(dimensions.x, dimensions.y, dimensions.z);

  if (!Number.isFinite(longestSide) || longestSide <= 0) throw new Error('EMPTY_MODEL');
  model.position.sub(center);
  const centered = new THREE.Group();

  centered.add(model);
  centered.scale.setScalar(size / longestSide);
  return centered;
}

function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xe2f3ff, 0x273847, 2.5));
  const keyLight = new THREE.DirectionalLight(0xf2f7ff, 3.3);

  keyLight.position.set(3, 6, 5);
  scene.add(keyLight);
  const edgeLight = new THREE.DirectionalLight(0x89b9d7, 2.2);

  edgeLight.position.set(-4, 3, -3);
  scene.add(edgeLight);
}

export default function PumpSimulationScene({
  hasSignal,
  selectedPartId,
  onSelectPart,
  onPartHover,
  viewMode = 'pump',
}: PumpSimulationSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const mainViewportRef = useRef<HTMLDivElement>(null);

  const partViewportRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const livePropsRef = useRef({ hasSignal, selectedPartId });

  const hoveredPartRef = useRef<string | null>(null);

  const requestRenderRef = useRef<() => void>(() => {});

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const [graphicsUnavailable, setGraphicsUnavailable] = useState(false);

  const [partModelStatus, setPartModelStatus] = useState<('loading' | 'ready' | 'error')[]>(
    SIMULATION_PARTS.map(() => 'loading'),
  );

  useEffect(() => {
    livePropsRef.current = { hasSignal, selectedPartId };
    requestRenderRef.current();
  }, [hasSignal, selectedPartId]);

  useEffect(() => {
    const container = containerRef.current;

    const mainViewport = mainViewportRef.current;

    if (!container || !mainViewport) return;
    setModelStatus('loading');
    setPartModelStatus(SIMULATION_PARTS.map(() => 'loading'));
    setGraphicsUnavailable(false);
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setGraphicsUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x0b141c, 0);
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.className = 'pump-simulation-canvas';
    renderer.domElement.setAttribute(
      'aria-label',
      viewMode === 'pump'
        ? '마우스로 회전하고 휠로 확대하는 펌프 3D 설비'
        : '마우스로 회전하고 휠로 확대하는 세 부품의 3D 모음',
    );
    renderer.domElement.setAttribute('role', 'img');
    container.prepend(renderer.domElement);
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);

    camera.position.set(6.5, 3.4, 6.2);
    addLights(scene);
    const controls = new OrbitControls(camera, mainViewport);

    controls.target.set(0, 0, 0);
    controls.minDistance = 4;
    controls.maxDistance = 18;
    controls.enablePan = false;
    controls.maxPolarAngle = Math.PI * 0.83;
    controls.update();
    const partScenes = SIMULATION_PARTS.map(() => {
      const partScene = new THREE.Scene();

      addLights(partScene);
      return partScene;
    });

    const partCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 20);

    partCamera.position.set(2.5, 1.6, 3.4);
    partCamera.lookAt(0, 0, 0);
    const partModels: (THREE.Group | null)[] = SIMULATION_PARTS.map(() => null);

    const loadedRoots: THREE.Object3D[] = [];

    const signalMaterials: {
      material: THREE.MeshStandardMaterial;
      color: THREE.Color;
      emissive: THREE.Color;
      intensity: number;
    }[] = [];

    const signalColor = new THREE.Color(0xc91f25);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let disposed = false;

    let visible = true;

    let animationFrame = 0;

    let lastFrameTime = 0;

    let lastMotionTime = 0;

    let mainBounds: Viewport = { left: 0, bottom: 0, width: 1, height: 1 };

    let partBounds: Viewport[] = [];

    const drawScene = (
      targetScene: THREE.Scene,
      targetCamera: THREE.PerspectiveCamera,
      viewport: Viewport,
    ) => {
      targetCamera.aspect = viewport.width / viewport.height;
      targetCamera.updateProjectionMatrix();
      renderer.setViewport(viewport.left, viewport.bottom, viewport.width, viewport.height);
      renderer.setScissor(viewport.left, viewport.bottom, viewport.width, viewport.height);
      renderer.clearDepth();
      renderer.render(targetScene, targetCamera);
    };

    const renderFrame = (time: number) => {
      animationFrame = 0;
      if (disposed || !visible || document.hidden) return;
      // 3D 변화가 있는 동안만 최대 30fps로 그린다. 화면 밖에서는 중단한다.
      if (time - lastFrameTime < 32) {
        requestRender();
        return;
      }
      const elapsed = lastMotionTime ? Math.min((time - lastMotionTime) / 1000, 0.1) : 0;

      lastFrameTime = time;
      lastMotionTime = time;
      // 부품 모음은 형상 확인용이다. 이상 신호로 개별 부품을 붉게 칠하지 않는다.
      const hasCurrentSignal = viewMode === 'pump' && livePropsRef.current.hasSignal;

      for (const state of signalMaterials) {
        state.material.color.copy(state.color);
        if (hasCurrentSignal) state.material.color.lerp(signalColor, 0.55);
        state.material.emissive.copy(hasCurrentSignal ? signalColor : state.emissive);
        state.material.emissiveIntensity = hasCurrentSignal ? 0.5 : state.intensity;
      }
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.setScissorTest(true);
      drawScene(scene, camera, mainBounds);
      for (const [index, model] of partModels.entries()) {
        if (!model || !partBounds[index]) continue;
        const isHighlighted =
          hoveredPartRef.current === SIMULATION_PARTS[index].id ||
          livePropsRef.current.selectedPartId === SIMULATION_PARTS[index].id;

        if (!reducedMotion.matches) model.rotation.y += elapsed * 0.22;
        const targetScale = isHighlighted ? 1.11 : 1;

        const scale = reducedMotion.matches
          ? targetScale
          : THREE.MathUtils.lerp(model.userData.hoverScale || 1, targetScale, 0.18);

        model.userData.hoverScale = scale;
        model.scale.setScalar(model.userData.normalizedScale * scale);
        model.position.z = isHighlighted ? 0.12 : 0;
        drawScene(partScenes[index], partCamera, partBounds[index]);
      }
      if (!reducedMotion.matches && partModels.some(Boolean)) requestRender();
    };

    function requestRender() {
      if (!disposed && visible && !document.hidden && !animationFrame) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    }

    requestRenderRef.current = requestRender;
    controls.addEventListener('change', requestRender);
    const readBounds = (element: HTMLElement, outer: DOMRect): Viewport => {
      const bounds = element.getBoundingClientRect();

      return {
        left: bounds.left - outer.left,
        bottom: outer.bottom - bounds.bottom,
        width: Math.max(bounds.width, 1),
        height: Math.max(bounds.height, 1),
      };
    };

    const resize = () => {
      const outer = container.getBoundingClientRect();

      renderer.setSize(Math.max(outer.width, 1), Math.max(outer.height, 1), false);
      mainBounds = readBounds(mainViewport, outer);
      partBounds = partViewportRefs.current.map((element) => {
        if (!element) return { left: 0, bottom: 0, width: 1, height: 1 };
        const bounds = readBounds(element, outer);

        // 부품 이름이 있는 아래쪽은 비워 3D 모델과 글자가 겹치지 않게 한다.
        return { ...bounds, bottom: bounds.bottom + 22, height: Math.max(bounds.height - 31, 1) };
      });
      requestRender();
    };

    const resizeObserver = new ResizeObserver(resize);

    resizeObserver.observe(container);
    resizeObserver.observe(mainViewport);
    for (const element of partViewportRefs.current) if (element) resizeObserver.observe(element);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible && animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastMotionTime = 0;
      if (visible) requestRender();
    });

    visibilityObserver.observe(container);
    const onDocumentVisibility = () => {
      if (document.hidden && animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastMotionTime = 0;
      if (!document.hidden) requestRender();
    };

    document.addEventListener('visibilitychange', onDocumentVisibility);
    reducedMotion.addEventListener('change', requestRender);
    const loader = new GLTFLoader();

    loader.load(
      viewMode === 'pump' ? PUMP_MODEL_URL : PARTS_COLLECTION_MODEL_URL,
      (loaded) => {
        if (disposed) {
          disposeModel(loaded.scene);
          return;
        }
        loadedRoots.push(loaded.scene);
        // 제공 파일의 촬영용 바닥은 설비가 아니므로 카메라 크기 계산에서 제외한다.
        const studioObjects: THREE.Object3D[] = [];

        loaded.scene.traverse((object) => {
          if (object.name.startsWith('Studio')) studioObjects.push(object);
          if (!(object instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material]) {
            if (
              material instanceof THREE.MeshStandardMaterial &&
              !signalMaterials.some((state) => state.material === material)
            ) {
              signalMaterials.push({
                material,
                color: material.color.clone(),
                emissive: material.emissive.clone(),
                intensity: material.emissiveIntensity,
              });
            }
          }
        });
        for (const object of studioObjects) {
          object.removeFromParent();
          loadedRoots.push(object);
        }
        try {
          scene.add(centerModel(loaded.scene, 5.3));
          setModelStatus('ready');
          resize();
        } catch {
          setModelStatus('error');
        }
      },
      undefined,
      () => {
        if (!disposed) setModelStatus('error');
      },
    );
    for (const [index, part] of SIMULATION_PARTS.entries()) {
      if (!part.modelUrl) continue;
      loader.load(
        part.modelUrl,
        (loaded) => {
          if (disposed) {
            disposeModel(loaded.scene);
            return;
          }
          loadedRoots.push(loaded.scene);
          try {
            const model = centerModel(loaded.scene, 1.65);

            model.userData.normalizedScale = model.scale.x;
            partModels[index] = model;
            partScenes[index].add(model);
            setPartModelStatus((previous) =>
              previous.map((status, partIndex) => (partIndex === index ? 'ready' : status)),
            );
            requestRender();
          } catch {
            setPartModelStatus((previous) =>
              previous.map((status, partIndex) => (partIndex === index ? 'error' : status)),
            );
          }
        },
        undefined,
        () => {
          if (!disposed)
            setPartModelStatus((previous) =>
              previous.map((status, partIndex) => (partIndex === index ? 'error' : status)),
            );
        },
      );
    }
    resize();
    return () => {
      disposed = true;
      requestRenderRef.current = () => {};
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener('visibilitychange', onDocumentVisibility);
      reducedMotion.removeEventListener('change', requestRender);
      controls.dispose();
      for (const root of loadedRoots) disposeModel(root);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [viewMode]);

  const hoverPart = (partId: string | null) => {
    hoveredPartRef.current = partId;
    onPartHover?.(partId);
    requestRenderRef.current();
  };

  return (
    <div
      ref={containerRef}
      className={`pump-simulation-stage${hasSignal && viewMode === 'pump' ? ' has-signal' : ''}`}
    >
      <div ref={mainViewportRef} className="pump-simulation-main">
        <div className="pump-simulation-caption">
          <span>CP / 01</span>
          <h2>{viewMode === 'pump' ? '원심 펌프' : '부품 전체'}</h2>
          <p>
            {viewMode === 'parts'
              ? '임펠러 · 베어링 · 메커니컬 씰의 형상을 함께 확인해요.'
              : hasSignal
                ? '모델이 점검 신호를 감지했어요.'
                : '수신된 값으로 점검 신호를 확인해요.'}
          </p>
        </div>
        {(graphicsUnavailable || modelStatus === 'error') && (
          <div className="pump-simulation-fallback" role="status">
            <Box size={34} />
            <strong>
              {graphicsUnavailable
                ? '이 환경에서는 3D를 표시할 수 없어요.'
                : '3D 파일을 불러오지 못했어요.'}
            </strong>
            <p>CSV 재생과 모델 점검은 계속 사용할 수 있어요.</p>
          </div>
        )}
        {!graphicsUnavailable && modelStatus === 'loading' && (
          <p className="pump-simulation-loading" role="status">
            3D 파일을 불러오고 있어요.
          </p>
        )}
        <p className="pump-simulation-controls">
          <Rotate3D size={15} /> 드래그 회전 · 휠 확대
        </p>
        {hasSignal && viewMode === 'pump' && (
          <p className="pump-simulation-signal-note">
            붉은색은 펌프 전체의 점검 신호예요. 고장 부품을 특정한 표시는 아닙니다.
          </p>
        )}
      </div>
      <aside className="pump-simulation-parts" aria-label="교체 부품 검토">
        <span className="pump-simulation-parts-label">부품 검토</span>
        {SIMULATION_PARTS.map((part, index) => (
          <button
            ref={(element) => {
              partViewportRefs.current[index] = element;
            }}
            key={part.id}
            data-part-id={part.id}
            type="button"
            className={`pump-simulation-part${selectedPartId === part.id ? ' is-selected' : ''}`}
            aria-pressed={selectedPartId === part.id}
            aria-label={`${part.label} 검토${part.modelUrl ? '' : ' · GLB 파일 대기'}`}
            onPointerEnter={() => hoverPart(part.id)}
            onPointerLeave={() => hoverPart(null)}
            onFocus={() => hoverPart(part.id)}
            onBlur={() => hoverPart(null)}
            onPointerDown={(event) => {
              pointerStartRef.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => {
              const start = pointerStartRef.current;

              pointerStartRef.current = null;
              if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6)
                onSelectPart(part.id);
            }}
            onPointerCancel={() => {
              pointerStartRef.current = null;
            }}
            onClick={(event) => {
              if (event.detail === 0) onSelectPart(part.id);
            }}
          >
            <span className="pump-simulation-part-index">0{index + 1}</span>
            {(!part.modelUrl || graphicsUnavailable || partModelStatus[index] !== 'ready') && (
              <span className="pump-simulation-empty-slot">
                <Box size={26} strokeWidth={1} />
                <span>
                  {!part.modelUrl
                    ? 'GLB 파일 대기'
                    : graphicsUnavailable
                      ? '3D 표시 불가'
                      : partModelStatus[index] === 'error'
                        ? '파일 확인 필요'
                        : '모델 불러오는 중'}
                </span>
              </span>
            )}
            <strong>{part.label}</strong>
            <span className="pump-simulation-part-link" aria-hidden="true" />
          </button>
        ))}
        <p className="pump-simulation-parts-note">
          부품과 채널의 실제 연결 정보는 아직 미지정이에요.
        </p>
      </aside>
    </div>
  );
}
