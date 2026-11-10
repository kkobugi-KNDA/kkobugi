import { describe, expect, it } from 'vitest';
import { DEMO_DATASET_DETAIL, DEMO_RUN_DETAIL } from '../data/demo';
import { resolveAssistantContext } from './assistant-context';

const previousDataset = DEMO_DATASET_DETAIL.dataset;

const uploadedDataset = { ...previousDataset, id: 'new-csv', filename: 'cal01_base_v7.csv' };

const previousRun = { ...DEMO_RUN_DETAIL.run, dataset_id: previousDataset.id };

const workspace = {
  pathname: '/data',
  datasets: [uploadedDataset, previousDataset],
  selectedDatasetId: uploadedDataset.id,
  runs: [previousRun],
  selectedRunId: previousRun.id,
};

describe('현재 화면의 CSV와 모델 문맥', () => {
  it.each(['/data', '/models'])(
    '새 CSV를 선택한 %s에서는 과거 모델을 붙이지 않는다',
    (pathname) => {
      expect(resolveAssistantContext({}, { ...workspace, pathname })).toMatchObject({
        datasetId: uploadedDataset.id,
        datasetName: 'cal01_base_v7.csv',
        runId: null,
        modelKey: null,
      });
    },
  );

  it('명시적으로 연 과거 평가 결과는 그 실행의 CSV를 참조한다', () => {
    expect(
      resolveAssistantContext({ runId: previousRun.id, modelKey: 'xgboost' }, workspace),
    ).toMatchObject({ datasetId: previousDataset.id, datasetName: previousDataset.filename });
  });

  it('CSV를 모두 제거하면 전에 선택했던 모델 데이터를 새 CSV라고 전달하지 않는다', () => {
    expect(
      resolveAssistantContext({}, { ...workspace, datasets: [], selectedDatasetId: null }),
    ).toMatchObject({ datasetId: null, runId: null, modelKey: null });
  });

  it('학습 전 안내의 null 실행을 이전 학습 모델로 채우지 않는다', () => {
    expect(
      resolveAssistantContext(
        { datasetId: uploadedDataset.id, runId: null, contextKey: 'plan' },
        workspace,
      ),
    ).toMatchObject({ datasetId: uploadedDataset.id, runId: null, modelKey: null });
  });
});
