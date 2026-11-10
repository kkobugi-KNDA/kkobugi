import type { AssistantCostInput } from './ax-api';
import type { SimulationChatContext } from './chat-api';

export const ASSISTANT_OPEN_EVENT = 'kkobugi:assistant-open';

export const SIMULATION_STATUS_EVENT = 'kkobugi:simulation-status';

export interface AssistantOpenDetail {
  datasetId?: string | null;
  datasetName?: string;
  runId?: string | null;
  modelKey?: string | null;
  split?: 'validation' | 'test';
  selectedSignal?: string;
  suggestedCostInputs?: AssistantCostInput;
  contextKey?: string;
  simulationContext?: SimulationChatContext | null;
  initialQuestion?: string;
}

export interface SimulationAssistantStatus extends AssistantOpenDetail {
  ownerId: number;
  simulationContext: SimulationChatContext;
  error?: string;
  preview?: boolean;
}

let latestSimulationStatus: SimulationAssistantStatus | null = null;

export function openPetAssistant(detail: AssistantOpenDetail = {}) {
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT, { detail }));
}

export function publishSimulationStatus(status: SimulationAssistantStatus | null) {
  latestSimulationStatus = status;
  window.dispatchEvent(new CustomEvent(SIMULATION_STATUS_EVENT, { detail: status }));
}

export function readSimulationStatus() {
  return latestSimulationStatus;
}
