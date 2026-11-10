import type { DatasetSummary, RunSummary } from '../types';
import type { AssistantOpenDetail } from './assistant-events';

interface WorkspaceContext {
  pathname: string;
  datasets: DatasetSummary[];
  selectedDatasetId: string | null;
  runs: RunSummary[];
  selectedRunId: string | null;
}

/** 데이터 화면은 현재 CSV, 결과·부품 버튼은 명시적으로 지정한 실행을 참조한다. */
export function resolveAssistantContext(
  detail: AssistantOpenDetail,
  workspace: WorkspaceContext,
): AssistantOpenDetail {
  const explicitContext =
    Boolean(detail.contextKey) || detail.datasetId !== undefined || detail.runId !== undefined;

  const selectedRun = workspace.runs.find(
    (run) => run.id === workspace.selectedRunId && run.status === 'completed',
  );

  const datasetPage = ['/data', '/models'].includes(workspace.pathname);

  const context: AssistantOpenDetail = explicitContext
    ? { ...detail }
    : datasetPage
      ? {
          datasetId: workspace.selectedDatasetId,
          runId: null,
          modelKey: null,
          contextKey: `dataset:${workspace.selectedDatasetId || 'none'}`,
        }
      : {
          runId: selectedRun?.selected_model ? selectedRun.id : null,
          modelKey: selectedRun?.selected_model || null,
          split: selectedRun?.evaluation_status === 'completed' ? 'test' : 'validation',
        };

  const contextRun = workspace.runs.find((run) => run.id === context.runId);

  const datasetId = context.datasetId ?? contextRun?.dataset_id ?? null;

  const dataset = workspace.datasets.find((item) => item.id === datasetId);

  return {
    ...context,
    datasetId,
    datasetName: context.datasetName || dataset?.filename,
    runId: context.runId ?? null,
    modelKey: context.modelKey ?? null,
  };
}
