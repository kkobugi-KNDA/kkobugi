import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ModelsPage from './ModelsPage';
import {
  DEMO_DATASET_DETAIL,
  DEMO_EVALUATION,
  DEMO_MODELS,
  DEMO_RESULTS,
  DEMO_RUN_DETAIL,
} from '../data/demo';
import type { DatasetDetail, ModelDefinition, RunDetail } from '../types';

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  api: {
    models: vi.fn(),
    dataset: vi.fn(),
    run: vi.fn(),
    results: vi.fn(),
    createRun: vi.fn(),
    selectModel: vi.fn(),
    evaluate: vi.fn(),
    evaluation: vi.fn(),
  },
}));
vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));
vi.mock('../lib/api', () => ({
  api: mocks.api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : '요청 오류'),
}));

function context(selectedRunId: string | null = null) {
  return {
    mode: 'live',
    datasets: [DEMO_DATASET_DETAIL.dataset],
    runs: selectedRunId ? [DEMO_RUN_DETAIL.run] : [],
    runsLoading: false,
    selectedDatasetId: DEMO_DATASET_DETAIL.dataset.id,
    selectedRunId,
    setSelectedDatasetId: vi.fn(),
    setSelectedRunId: vi.fn(),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  };
}
const activeCatalog: ModelDefinition[] = [
  DEMO_MODELS[1],
  { ...DEMO_MODELS[1], key: 'lightgbm', display_name: 'LightGBM' },
  DEMO_MODELS[2],
];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.useApp.mockReturnValue(context());
  mocks.api.models.mockResolvedValue({ items: activeCatalog });
  mocks.api.dataset.mockResolvedValue(structuredClone(DEMO_DATASET_DETAIL));
  mocks.api.results.mockResolvedValue(structuredClone(DEMO_RESULTS));
  mocks.api.evaluation.mockResolvedValue(structuredClone(DEMO_EVALUATION));
});
function mount() {
  return render(
    <MemoryRouter>
      <ModelsPage />
    </MemoryRouter>,
  );
}

describe('모델 비교의 명시적 학습·선택·평가', () => {
  it.each([
    {
      timezone: 'naive' as const,
      trainEnd: '2018-04-01T03:29:00',
      validationEnd: '2018-04-01T04:49:00',
    },
    {
      timezone: 'aware' as const,
      trainEnd: '2018-04-01T03:29:00+09:00',
      validationEnd: '2018-04-01T04:49:00+09:00',
    },
  ])(
    '$timezone 경계를 변환하지 않고 catalog 모델·선택 채널과 함께 전송한다',
    async ({ timezone, trainEnd, validationEnd }) => {
      const data: DatasetDetail = structuredClone(DEMO_DATASET_DETAIL);
      data.inspection.timezone_mode = timezone;
      if (timezone === 'aware') {
        data.inspection.time_start += '+09:00';
        data.inspection.time_end += '+09:00';
      }
      mocks.api.dataset.mockResolvedValue(data);
      mocks.api.createRun.mockResolvedValue({
        ...structuredClone(DEMO_RUN_DETAIL),
        run: { ...DEMO_RUN_DETAIL.run, status: 'queued', selected_model: null },
      });
      const user = userEvent.setup();
      mount();
      await user.click(screen.getAllByRole('button', { name: '새 학습' })[0]);
      const drawer = await screen.findByRole('dialog', { name: '새 학습' });
      await within(drawer).findByText('LightGBM');
      expect(within(drawer).queryByText('DummyClassifier')).not.toBeInTheDocument();
      await user.click(within(drawer).getByRole('checkbox', { name: 'sensor_38' }));
      await user.type(within(drawer).getByLabelText('Train 종료 시각'), trainEnd);
      await user.type(within(drawer).getByLabelText('Valid 종료 시각'), validationEnd);
      expect(mocks.api.createRun).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '학습 시작' }));
      await waitFor(() => expect(mocks.api.createRun).toHaveBeenCalledTimes(1));
      expect(mocks.api.createRun).toHaveBeenCalledWith({
        dataset_id: data.dataset.id,
        feature_columns: ['sensor_04', 'sensor_10', 'sensor_20'],
        models: ['xgboost', 'lightgbm', 'autoencoder'],
        train_end: trainEnd,
        validation_end: validationEnd,
        ranking_metric: 'f1',
        random_seed: 42,
      });
      expect(mocks.api.selectModel).not.toHaveBeenCalled();
      expect(mocks.api.evaluate).not.toHaveBeenCalled();
    },
  );

  it('시간 경계가 거꾸로 입력되면 학습 요청을 보내지 않는다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getAllByRole('button', { name: '새 학습' })[0]);
    const drawer = await screen.findByRole('dialog', { name: '새 학습' });
    await within(drawer).findByText('LightGBM');
    await user.type(within(drawer).getByLabelText('Train 종료 시각'), '2018-04-01T04:49:00');
    await user.type(within(drawer).getByLabelText('Valid 종료 시각'), '2018-04-01T03:29:00');
    await user.click(screen.getByRole('button', { name: '학습 시작' }));
    expect(
      await screen.findByText(
        'Train 종료와 Valid 종료를 올바른 ISO 시각으로, 시간 순서에 맞게 입력해주세요.',
      ),
    ).toBeInTheDocument();
    expect(mocks.api.createRun).not.toHaveBeenCalled();
  });

  it('시간대가 있는 CSV에서 시간대 없는 경계를 조용히 보정하지 않는다', async () => {
    const data = structuredClone(DEMO_DATASET_DETAIL);
    data.inspection.timezone_mode = 'aware';
    mocks.api.dataset.mockResolvedValue(data);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getAllByRole('button', { name: '새 학습' })[0]);
    const drawer = await screen.findByRole('dialog', { name: '새 학습' });
    await within(drawer).findByText('LightGBM');
    await user.type(within(drawer).getByLabelText('Train 종료 시각'), '2018-04-01T03:29:00');
    await user.type(within(drawer).getByLabelText('Valid 종료 시각'), '2018-04-01T04:49:00');
    await user.click(screen.getByRole('button', { name: '학습 시작' }));
    expect(await screen.findByText(/두 경계의 시간대 표기를 CSV와 같게/)).toBeInTheDocument();
    expect(mocks.api.createRun).not.toHaveBeenCalled();
  });

  it('Valid 순위로 자동 선택·평가하지 않고, 모델 선택 후 별도 확인에서만 Test를 요청한다', async () => {
    let serverRun: RunDetail = structuredClone(DEMO_RUN_DETAIL);
    serverRun.run.selected_model = null;
    mocks.useApp.mockReturnValue(context(serverRun.run.id));
    mocks.api.run.mockImplementation(async () => structuredClone(serverRun));
    mocks.api.selectModel.mockImplementation(async (_id, key) => {
      serverRun.run.selected_model = key;
      return structuredClone(serverRun);
    });
    mocks.api.evaluate.mockImplementation(async () => {
      serverRun.run.evaluation_status = 'completed';
      return structuredClone(DEMO_EVALUATION);
    });
    const user = userEvent.setup();
    mount();
    await screen.findByText('어떤 모델을 사용할까요?');
    expect(mocks.api.selectModel).not.toHaveBeenCalled();
    expect(mocks.api.evaluate).not.toHaveBeenCalled();
    expect(mocks.api.evaluation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '이 모델로 Test 평가' })).toBeDisabled();
    const xgbRow = screen.getByText('XGBoost', { selector: 'strong' }).closest('tr')!;
    await user.click(within(xgbRow).getByRole('button', { name: '선택' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '이 모델로 Test 평가' })).toBeEnabled(),
    );
    expect(mocks.api.selectModel).toHaveBeenCalledWith(serverRun.run.id, 'xgboost');
    expect(mocks.api.evaluate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '이 모델로 Test 평가' }));
    const confirmation = await screen.findByRole('dialog', {
      name: '선택한 모델로 Test를 평가할까요?',
    });
    expect(mocks.api.evaluate).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: 'Test 평가 시작' }));
    await waitFor(() =>
      expect(mocks.api.evaluate).toHaveBeenCalledExactlyOnceWith(serverRun.run.id),
    );
    expect(
      await screen.findByText('Test 평가를 시작해서 모델 선택이 잠겼어요.'),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('button', { name: '선택' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
  });
});
