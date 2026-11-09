/** 제공한 GLB의 이름에 따라 부품을 표시한다. 채널과 부품의 인과관계는 별도 확인한다. */
export interface SimulationPart {
  id: string;
  label: string;
  modelUrl: string | null;
}

export const replacementPart1: SimulationPart = {
  id: 'part-1',
  label: '임펠러',
  modelUrl: '/models/impeller.glb',
};

export const replacementPart2: SimulationPart = {
  id: 'part-2',
  label: '베어링',
  modelUrl: '/models/bearing.glb',
};

export const replacementPart3: SimulationPart = {
  id: 'part-3',
  label: '메커니컬 씰',
  modelUrl: '/models/seal.glb',
};

export const SIMULATION_PARTS: SimulationPart[] = [
  replacementPart1,
  replacementPart2,
  replacementPart3,
];

export const PUMP_MODEL_URL = '/models/centrifugal_pump_white_shaded.glb';

/** 세 부품을 나란히 모은 파일이며, 펌프 전체 조립체를 대신하지 않는다. */
export const PARTS_COLLECTION_MODEL_URL = '/models/pump-parts.glb';
