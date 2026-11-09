import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ModelsPage, { learningScore } from './ModelsPage';
import ExpertiseToggle from '../components/ExpertiseToggle';
import { ExpertiseProvider } from '../context/ExpertiseContext';
import { DEMO_DATASET_DETAIL, DEMO_EVALUATION, DEMO_RESULTS, DEMO_RUN_DETAIL } from '../data/demo';
import type { RunDetail, TrainingProgressEvent } from '../types';

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  prepareTraining: vi.fn(),
  api: {
    dataset: vi.fn(),
    reinspectDataset: vi.fn(),
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
vi.mock('../lib/training-api', () => ({ prepareTraining: mocks.prepareTraining }));

function context(selectedRunId: string | null = null) {
  return {
    mode: 'live',
    user: { id: 1, username: 'worker', display_name: '작업자' },
    datasets: [DEMO_DATASET_DETAIL.dataset],
    runs: selectedRunId ? [DEMO_RUN_DETAIL.run] : [],
    selectedDatasetId: DEMO_DATASET_DETAIL.dataset.id,
    selectedRunId,
    setSelectedDatasetId: vi.fn(),
    setSelectedRunId: vi.fn(),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    refreshDatasets: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  };
}

function plan(model = 'xgboost') {
  return {
    configuration: {
      ...DEMO_RUN_DETAIL.configuration,
      models: [model],
      model_options:
        model === 'xgboost'
          ? { xgboost: { n_estimators: 100, max_depth: 4, learning_rate: 0.1 } }
          : { autoencoder: { max_iter: 100, hidden_size: 32, threshold_quantile: 0.99 } },
    },
    split: { train_rows: 210, validation_rows: 80, test_rows: 70 },
    notes: ['시간 순서를 유지합니다.'],
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <ExpertiseProvider>
        <ExpertiseToggle />
        <ModelsPage />
      </ExpertiseProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  mocks.useApp.mockReturnValue(context());
  mocks.api.dataset.mockResolvedValue(structuredClone(DEMO_DATASET_DETAIL));
  mocks.api.results.mockResolvedValue(structuredClone(DEMO_RESULTS));
  mocks.api.evaluation.mockResolvedValue(structuredClone(DEMO_EVALUATION));
  mocks.prepareTraining.mockImplementation(async (request) => plan(request.model_key));
  mocks.api.createRun.mockResolvedValue({
    ...structuredClone(DEMO_RUN_DETAIL),
    run: { ...DEMO_RUN_DETAIL.run, status: 'queued', selected_model: null },
  });
});

describe('한 모델씩 학습하는 Pro·Pro+ 흐름', () => {
  it('학습을 막은 열·개수를 보여주고 같은 원본을 다시 검사한 뒤 자동 설정한다', async () => {
    const oldInspection = structuredClone(DEMO_DATASET_DETAIL);

    oldInspection.dataset.status = 'needs_review';
    oldInspection.dataset.channels.push('machine_status');
    oldInspection.inspection.channels.push('machine_status');
    oldInspection.inspection.columns.push('machine_status');
    oldInspection.inspection.is_valid = false;
    oldInspection.inspection.issues = [
      {
        code: 'INVALID_NUMERIC_VALUES',
        column: 'machine_status',
        count: 360,
        severity: 'error',
        message: '유한한 숫자로 읽을 수 없는 값이 있습니다.',
      },
    ];
    const checked = structuredClone(oldInspection);

    checked.dataset.status = 'valid';
    checked.dataset.channels = checked.dataset.channels.filter((name) => name !== 'machine_status');
    checked.inspection.channels = checked.inspection.channels.filter(
      (name) => name !== 'machine_status',
    );
    checked.inspection.ignored_columns = ['machine_status'];
    checked.inspection.is_valid = true;
    checked.inspection.issues = [];
    mocks.api.dataset.mockResolvedValue(oldInspection);
    mocks.api.reinspectDataset.mockResolvedValue(checked);
    const user = userEvent.setup();

    mount();
    const issues = await screen.findByRole('list', { name: 'CSV에서 확인할 항목' });

    expect(issues).toHaveTextContent('machine_status · 360건');
    expect(issues).toHaveTextContent('유한한 숫자로 읽을 수 없는 값');
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeDisabled();
    expect(mocks.prepareTraining).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'CSV 다시 검사' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled());
    expect(mocks.api.reinspectDataset).toHaveBeenCalledWith(
      oldInspection.dataset.id,
      expect.any(AbortSignal),
    );
    expect(mocks.prepareTraining.mock.calls[0][0].feature_columns).not.toContain('machine_status');
    expect(screen.getByText(/학습 입력에서 제외한 상태 열: machine_status/)).toBeInTheDocument();
    expect(mocks.api.createRun).not.toHaveBeenCalled();
  });

  it('예전 검사에서 숫자였어도 상태 열을 재검사하기 전에는 학습하지 않는다', async () => {
    const previous = structuredClone(DEMO_DATASET_DETAIL);

    previous.dataset.channels.push('all_sensors_missing');
    previous.inspection.channels.push('all_sensors_missing');
    mocks.api.dataset.mockResolvedValue(previous);
    mount();
    expect(await screen.findByRole('button', { name: 'CSV 다시 검사' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeDisabled();
    expect(mocks.prepareTraining).not.toHaveBeenCalled();
  });

  it('CSV 재검사 실패는 원인을 남기고 기존 검사와 학습 중단 상태를 유지한다', async () => {
    const invalid = structuredClone(DEMO_DATASET_DETAIL);

    invalid.dataset.status = 'needs_review';
    invalid.inspection.is_valid = false;
    invalid.inspection.issues = [
      {
        code: 'MISSING_VALUES',
        column: 'sensor_00',
        count: 12,
        severity: 'error',
        message: '비어 있는 값이 있습니다.',
      },
    ];
    mocks.api.dataset.mockResolvedValue(invalid);
    mocks.api.reinspectDataset.mockRejectedValue(new Error('등록 당시와 CSV 내용이 다릅니다.'));
    const user = userEvent.setup();

    mount();
    expect(await screen.findByRole('list', { name: 'CSV에서 확인할 항목' })).toHaveTextContent(
      'sensor_00 · 12건',
    );
    await user.click(screen.getByRole('button', { name: 'CSV 다시 검사' }));
    expect(await screen.findByText('등록 당시와 CSV 내용이 다릅니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeDisabled();
    expect(mocks.prepareTraining).not.toHaveBeenCalled();
  });

  it('CSV를 선택하면 버튼 클릭 없이 시간 경계를 채우고 학습 시작을 활성화한다', async () => {
    localStorage.setItem('kkobugi:expertise', 'pro-plus');
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText('Train 종료 시각')).toHaveValue(plan().configuration.train_end),
    );
    expect(screen.getByLabelText('Valid 종료 시각')).toHaveValue(
      plan().configuration.validation_end,
    );
    expect(mocks.prepareTraining).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled();
    expect(mocks.api.createRun).not.toHaveBeenCalled();
  });

  it('비율·모델 변경 시 새 경계를 채우되 사용자가 입력한 모델 옵션은 보존한다', async () => {
    localStorage.setItem('kkobugi:expertise', 'pro-plus');
    mocks.prepareTraining.mockImplementation(async (request) => ({
      ...plan(request.model_key),
      configuration: {
        ...plan(request.model_key).configuration,
        train_end: request.train_ratio === 0.6 ? '2018-04-01T03:00:00' : '2018-04-01T03:29:00',
        validation_end: request.train_ratio === 0.6 ? '2018-04-01T04:00:00' : '2018-04-01T04:49:00',
      },
    }));
    const user = userEvent.setup();

    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled());
    await user.click(screen.getByText('채널·시간 경계·모델 옵션 직접 설정'));
    const treeCount = screen.getByLabelText('트리 수 · n_estimators');

    await user.clear(treeCount);
    await user.type(treeCount, '120');
    await user.selectOptions(screen.getByLabelText('Train : Valid : Test'), '60:20:20');
    await waitFor(() =>
      expect(screen.getByLabelText('Train 종료 시각')).toHaveValue('2018-04-01T03:00:00'),
    );
    expect(screen.getByLabelText('Valid 종료 시각')).toHaveValue('2018-04-01T04:00:00');
    expect(treeCount).toHaveValue(120);
    await user.click(screen.getByRole('radio', { name: /AutoEncoder/ }));
    await waitFor(() =>
      expect(mocks.prepareTraining.mock.calls.at(-1)?.[0]).toMatchObject({
        model_key: 'autoencoder',
        train_ratio: 0.6,
        validation_ratio: 0.2,
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled());
    expect(screen.getByLabelText('Train 종료 시각')).toHaveValue('2018-04-01T03:00:00');
    expect(mocks.api.createRun).not.toHaveBeenCalled();
  });

  it('자동 시각 설정 실패를 표시하고 재시도한 뒤에만 학습 시작을 활성화한다', async () => {
    mocks.prepareTraining.mockRejectedValueOnce(
      new Error('학습 구간에 정상·비정상이 모두 필요해요.'),
    );
    const user = userEvent.setup();

    mount();
    expect(await screen.findByText('학습 구간에 정상·비정상이 모두 필요해요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '자동 설정' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled());
    expect(screen.queryByText('학습 구간에 정상·비정상이 모두 필요해요.')).not.toBeInTheDocument();
  });

  it('자동 설정 응답을 기다리며 입력한 수동 시각을 늦은 응답이 덮어쓰지 않는다', async () => {
    localStorage.setItem('kkobugi:expertise', 'pro-plus');
    let resolvePlan: (value: ReturnType<typeof plan>) => void = () => {};

    mocks.prepareTraining.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    );
    const user = userEvent.setup();

    mount();
    await waitFor(() => expect(mocks.prepareTraining).toHaveBeenCalledOnce());
    const requestSignal = mocks.prepareTraining.mock.calls[0][1] as AbortSignal;

    await user.click(screen.getByText('채널·시간 경계·모델 옵션 직접 설정'));
    await user.type(screen.getByLabelText('Train 종료 시각'), '2018-04-01T02:00:00');
    await user.type(screen.getByLabelText('Valid 종료 시각'), '2018-04-01T04:00:00');
    await act(async () => resolvePlan(plan()));
    expect(requestSignal.aborted).toBe(true);
    expect(screen.getByLabelText('Train 종료 시각')).toHaveValue('2018-04-01T02:00:00');
    expect(screen.getByLabelText('Valid 종료 시각')).toHaveValue('2018-04-01T04:00:00');
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled();
  });

  it('자동 요청이 출발하기 전에 입력한 수동 시각도 예약된 재계산으로 덮지 않는다', async () => {
    vi.useFakeTimers();
    localStorage.setItem('kkobugi:expertise', 'pro-plus');
    try {
      mount();
      await act(async () => {});
      fireEvent.change(screen.getByLabelText('Train 종료 시각'), {
        target: { value: '2018-04-01T02:00:00' },
      });
      fireEvent.change(screen.getByLabelText('Valid 종료 시각'), {
        target: { value: '2018-04-01T04:00:00' },
      });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(mocks.prepareTraining).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Train 종료 시각')).toHaveValue('2018-04-01T02:00:00');
      expect(screen.getByLabelText('Valid 종료 시각')).toHaveValue('2018-04-01T04:00:00');
      expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('직접 정한 시간 경계는 모델을 바꾸어도 그대로 학습 요청에 사용한다', async () => {
    localStorage.setItem('kkobugi:expertise', 'pro-plus');
    const user = userEvent.setup();

    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '학습 시작' })).toBeEnabled());
    await user.click(screen.getByText('채널·시간 경계·모델 옵션 직접 설정'));
    await user.clear(screen.getByLabelText('Train 종료 시각'));
    await user.type(screen.getByLabelText('Train 종료 시각'), '2018-04-01T02:00:00');
    await user.clear(screen.getByLabelText('Valid 종료 시각'));
    await user.type(screen.getByLabelText('Valid 종료 시각'), '2018-04-01T04:00:00');
    await user.click(screen.getByRole('radio', { name: /AutoEncoder/ }));
    expect(screen.getByLabelText('Train 종료 시각')).toHaveValue('2018-04-01T02:00:00');
    expect(screen.getByLabelText('Valid 종료 시각')).toHaveValue('2018-04-01T04:00:00');
    await user.click(screen.getByRole('button', { name: '학습 시작' }));
    await waitFor(() => expect(mocks.api.createRun).toHaveBeenCalledOnce());
    expect(mocks.api.createRun.mock.calls[0][0]).toMatchObject({
      models: ['autoencoder'],
      train_end: '2018-04-01T02:00:00',
      validation_end: '2018-04-01T04:00:00',
    });
    expect(mocks.prepareTraining).toHaveBeenCalledOnce();
  });

  it('학습 전에는 진행할 순서만 안내하고 완료 상태를 만들어내지 않는다', () => {
    mount();
    const preview = screen.getByRole('region', { name: '학습을 시작하면 진행할 순서' });

    expect(within(preview).getAllByRole('listitem')).toHaveLength(7);
    expect(within(preview).getByText('원본 확인')).toBeInTheDocument();
    expect(within(preview).getByText('모델 저장')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '실제 학습 단계' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('예전 완료 실행에 단계별 기록이 없으면 실제 단계 완료를 추측하지 않는다', async () => {
    mocks.useApp.mockReturnValue(context(DEMO_RUN_DETAIL.run.id));
    mocks.api.run.mockResolvedValue(structuredClone(DEMO_RUN_DETAIL));
    mount();
    expect(
      await screen.findByText(
        '이 실행에는 단계별 진행 기록이 없어요. 저장된 전체 상태만 확인할 수 있어요.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '실제 학습 단계' })).not.toBeInTheDocument();
  });

  it('서버가 실제로 기록한 단계만 표시하고 같은 run 조회로 저장 완료까지 갱신한다', async () => {
    const starting = structuredClone(DEMO_RUN_DETAIL);

    const firstEvent: TrainingProgressEvent = {
      stage: 'training',
      status: 'running',
      timestamp: 1794260000,
      message: '선택한 XGBoost 학습을 시작했습니다.',
      model_key: 'xgboost',
    };

    starting.run.status = 'running';
    starting.configuration.models = ['xgboost'];
    starting.training_progress = [
      {
        stage: 'data_check',
        status: 'completed',
        timestamp: 1794259990,
        message: '등록된 CSV 해시를 확인했습니다.',
      },
      firstEvent,
    ];
    const finished = structuredClone(starting);

    finished.run.status = 'completed';
    finished.training_progress = [
      ...starting.training_progress,
      {
        ...firstEvent,
        status: 'completed',
        timestamp: 1794260002,
        message: 'XGBoost 학습을 마쳤습니다.',
      },
      {
        stage: 'saving',
        status: 'completed',
        timestamp: 1794260003,
        message: '모델 파일을 저장했습니다.',
      },
      {
        stage: 'completed',
        status: 'completed',
        timestamp: 1794260004,
        message: '선택한 모델의 저장을 마쳤습니다.',
      },
    ];
    mocks.useApp.mockReturnValue(context(starting.run.id));
    mocks.api.run.mockResolvedValueOnce(starting).mockResolvedValue(finished);
    const user = userEvent.setup();

    mount();
    const process = await screen.findByRole('region', { name: '실제 학습 과정' });

    expect(within(process).getByLabelText('모델 학습: 진행 중')).toBeInTheDocument();
    expect(within(process).getByLabelText('모델 저장: 기록 없음')).toBeInTheDocument();
    expect(within(process).queryByRole('progressbar')).not.toBeInTheDocument();
    await waitFor(
      () => expect(within(process).getByLabelText('학습 완료: 완료')).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(within(process).getByLabelText('모델 저장: 완료')).toBeInTheDocument();
    expect(within(process).getByLabelText('데이터 나누기: 기록 없음')).toBeInTheDocument();
    await user.click(within(process).getByText('실제 진행 기록과 사용한 설정'));
    const timeline = within(process).getByRole('list', { name: '서버의 실제 진행 기록' });

    expect(within(timeline).getByText(firstEvent.message)).toBeInTheDocument();
    expect(within(timeline).getByText('모델 파일을 저장했습니다.')).toBeInTheDocument();
    expect(timeline.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(1794259990 * 1000).toISOString(),
    );
    expect(within(process).getByText('pump-demo.csv')).toBeInTheDocument();
  });

  it('실패한 실제 단계를 표시하고 뒤 단계가 완료된 것처럼 보이지 않는다', async () => {
    const run = structuredClone(DEMO_RUN_DETAIL);

    run.run.status = 'failed';
    run.training_progress = [
      {
        stage: 'input_preparation',
        status: 'failed',
        timestamp: 1794260000,
        message: '선택한 채널에서 숫자가 아닌 값을 확인했습니다.',
      },
    ];
    mocks.useApp.mockReturnValue(context(run.run.id));
    mocks.api.run.mockResolvedValue(run);
    mount();
    const process = await screen.findByRole('region', { name: '실제 학습 과정' });

    expect(within(process).getByLabelText('학습 자료 준비: 실패')).toBeInTheDocument();
    expect(
      within(within(process).getByLabelText('학습 자료 준비: 실패')).getByText(
        '선택한 채널에서 숫자가 아닌 값을 확인했습니다.',
      ),
    ).toBeInTheDocument();
    expect(within(process).getByLabelText('모델 학습: 기록 없음')).toBeInTheDocument();
    expect(within(process).getByLabelText('학습 완료: 기록 없음')).toBeInTheDocument();
  });

  it.each(['pro', 'pro-plus'] as const)(
    '%s에서도 최종 확인의 이상 라벨 부족과 각 구간 분포를 학습 전에 표시한다',
    async (expertise) => {
      localStorage.setItem('kkobugi:expertise', expertise);
      const warning =
        '최종 확인 구간에 비정상 기록이 없어 비정상 탐지 점수를 계산할 수 없습니다. 날짜를 임의로 바꾸어 점수를 높이지 마세요.';

      const technicalNote = 'AutoEncoder의 스케일·재구성망·이상 기준은 정상 Train에서만 만듭니다.';

      mocks.prepareTraining.mockResolvedValue({
        ...plan(),
        notes: [technicalNote],
        warnings: [warning],
        label_counts: {
          train: { normal: 190, abnormal: 20 },
          validation: { normal: 70, abnormal: 10 },
          test: { normal: 70, abnormal: 0 },
        },
      });
      const user = userEvent.setup();

      mount();
      await waitFor(() => expect(screen.getByRole('button', { name: '자동 설정' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: '자동 설정' }));
      expect(await screen.findByText(warning)).toBeInTheDocument();
      const counts = screen.getByRole('table', { name: '각 구간의 라벨 분포' });

      const testRow = within(counts).getByRole('row', {
        name: expertise === 'pro-plus' ? 'Test 70행 0행' : '최종 확인 70행 0행',
      });

      expect(testRow).toBeInTheDocument();
      if (expertise === 'pro') expect(screen.queryByText(technicalNote)).not.toBeInTheDocument();
      expect(mocks.api.createRun).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '학습 시작' }));
      await waitFor(() =>
        expect(mocks.api.createRun).toHaveBeenCalledExactlyOnceWith(plan().configuration),
      );
    },
  );

  it('목록의 예전 상태보다 현재 조회한 완료 상태를 학습 기록에 표시한다', async () => {
    const run = structuredClone(DEMO_RUN_DETAIL);

    const app = context(run.run.id);

    app.runs[0] = { ...app.runs[0], status: 'running' };
    mocks.useApp.mockReturnValue(app);
    mocks.api.run.mockResolvedValue(run);
    mount();
    await screen.findByText('중간 확인 결과');
    const option = within(screen.getByLabelText('학습 기록 선택')).getByRole('option', {
      name: /pump-demo.csv/,
    });

    expect(option).toHaveTextContent('학습 완료');
    expect(option).not.toHaveTextContent('학습 중');
  });

  it('모델 저장만으로 모니터링을 열지 않고 최종 평가가 끝난 뒤에만 연결한다', async () => {
    let run = structuredClone(DEMO_RUN_DETAIL);

    run.configuration.models = ['xgboost'];
    run.run.selected_model = null;
    const app = context(run.run.id);

    mocks.useApp.mockReturnValue(app);
    mocks.api.run.mockImplementation(async () => structuredClone(run));
    mocks.api.selectModel.mockImplementation(async () => {
      run.run.selected_model = 'xgboost';
      return structuredClone(run);
    });
    const user = userEvent.setup();

    mount();
    await screen.findByText('중간 확인 결과');
    expect(screen.queryByRole('link', { name: '실시간 모니터링' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '사용할 모델 저장' }));
    await screen.findByText(/사용할 모델이 저장됐어요/);
    expect(app.toast).toHaveBeenCalledWith(
      '사용할 모델을 저장했어요. 최종 평가를 마친 뒤 모니터링에서 사용할 수 있어요.',
      'success',
    );
    expect(screen.queryByRole('link', { name: '실시간 모니터링' })).not.toBeInTheDocument();
    expect(mocks.api.evaluate).not.toHaveBeenCalled();
    run = { ...run, run: { ...run.run, evaluation_status: 'completed' } };
    await user.click(screen.getByRole('button', { name: '학습 결과 새로고침' }));
    expect(await screen.findByRole('link', { name: '실시간 모니터링' })).toHaveAttribute(
      'href',
      '/monitor',
    );
  });

  it('XGBoost 또는 AutoEncoder 하나만 자동 설정하고 명시한 학습 클릭에서만 전송한다', async () => {
    const user = userEvent.setup();

    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '자동 설정' })).toBeEnabled());
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /LightGBM/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /AutoEncoder/ }));
    await user.click(screen.getByRole('button', { name: '자동 설정' }));
    expect(await screen.findByText('210행')).toBeInTheDocument();
    expect(mocks.prepareTraining).toHaveBeenCalledWith(
      {
        dataset_id: DEMO_DATASET_DETAIL.dataset.id,
        model_key: 'autoencoder',
        train_ratio: 0.7,
        validation_ratio: 0.15,
        feature_columns: DEMO_DATASET_DETAIL.inspection.channels,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.api.createRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '학습 시작' }));
    await waitFor(() =>
      expect(mocks.api.createRun).toHaveBeenCalledExactlyOnceWith(
        plan('autoencoder').configuration,
      ),
    );
    expect(mocks.api.selectModel).not.toHaveBeenCalled();
    expect(mocks.api.evaluate).not.toHaveBeenCalled();
  });

  it('Pro는 같은 F1 결과를 한 점수로 보여주고 Pro+로 바꾸면 전문 지표가 보인다', async () => {
    const run = structuredClone(DEMO_RUN_DETAIL);

    run.configuration.models = ['xgboost'];
    mocks.useApp.mockReturnValue(context(run.run.id));
    mocks.api.run.mockResolvedValue(run);
    const expected = String(
      learningScore(
        DEMO_RESULTS.items.find((item) => item.model_key === 'xgboost')!.validation_metrics,
      ),
    );

    const user = userEvent.setup();

    mount();
    await screen.findByText('중간 확인 결과');
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'STRONG' && element.textContent === `${expected} / 100점`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Recall')).not.toBeInTheDocument();
    expect(screen.getByText(/고장 확률이나 설비의 건강 점수는 아니에요/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Pro\+$/ }));
    expect(screen.getByText('Recall')).toBeInTheDocument();
    expect(screen.getByText('Precision')).toBeInTheDocument();
    expect(screen.getByText('F1 score')).toBeInTheDocument();
    expect(screen.queryByText('중간 확인 결과')).not.toBeInTheDocument();
    expect(localStorage.getItem('kkobugi:expertise')).toBe('pro-plus');
    expect(mocks.api.selectModel).not.toHaveBeenCalled();
  });

  it('계산 불가를 0점으로 바꾸지 않는다', async () => {
    const run = structuredClone(DEMO_RUN_DETAIL);

    const results = structuredClone(DEMO_RESULTS);

    run.configuration.models = ['xgboost'];
    results.items.find((item) => item.model_key === 'xgboost')!.validation_metrics.f1 = null;
    mocks.useApp.mockReturnValue(context(run.run.id));
    mocks.api.run.mockResolvedValue(run);
    mocks.api.results.mockResolvedValue(results);
    mount();
    expect(await screen.findByText('계산할 수 없어요')).toBeInTheDocument();
    expect(screen.queryByText('/ 100점')).not.toBeInTheDocument();
  });

  it.each([
    {
      timezone: 'naive' as const,
      trainEnd: '2018-04-01T03:29:00',
      validEnd: '2018-04-01T04:49:00',
    },
    {
      timezone: 'aware' as const,
      trainEnd: '2018-04-01T03:29:00+09:00',
      validEnd: '2018-04-01T04:49:00+09:00',
    },
  ])(
    '$timezone 수동 시각과 채널을 자동 보정 없이 그대로 전송한다',
    async ({ timezone, trainEnd, validEnd }) => {
      localStorage.setItem('kkobugi:expertise', 'pro-plus');
      const dataset = structuredClone(DEMO_DATASET_DETAIL);

      dataset.inspection.timezone_mode = timezone;
      mocks.api.dataset.mockResolvedValue(dataset);
      const user = userEvent.setup();

      mount();
      await waitFor(() =>
        expect(screen.getByLabelText('Train 종료 시각')).toHaveValue(
          plan().configuration.train_end,
        ),
      );
      await user.click(screen.getByText('채널·시간 경계·모델 옵션 직접 설정'));
      await user.click(screen.getByRole('checkbox', { name: 'sensor_38' }));
      await user.clear(screen.getByLabelText('Train 종료 시각'));
      await user.type(screen.getByLabelText('Train 종료 시각'), trainEnd);
      await user.clear(screen.getByLabelText('Valid 종료 시각'));
      await user.type(screen.getByLabelText('Valid 종료 시각'), validEnd);
      await user.click(screen.getByRole('button', { name: '학습 시작' }));
      await waitFor(() => expect(mocks.api.createRun).toHaveBeenCalledOnce());
      expect(mocks.api.createRun.mock.calls[0][0]).toMatchObject({
        models: ['xgboost'],
        feature_columns: ['sensor_04', 'sensor_10', 'sensor_20'],
        train_end: trainEnd,
        validation_end: validEnd,
      });
      expect(mocks.prepareTraining).toHaveBeenCalledOnce();
    },
  );

  it('거꾸로 된 경계와 CSV와 다른 시간대는 서버에 보내지 않는다', async () => {
    localStorage.setItem('kkobugi:expertise', 'pro-plus');
    const dataset = structuredClone(DEMO_DATASET_DETAIL);

    dataset.inspection.timezone_mode = 'aware';
    mocks.api.dataset.mockResolvedValue(dataset);
    const user = userEvent.setup();

    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '자동 설정' })).toBeEnabled());
    await user.click(screen.getByText('채널·시간 경계·모델 옵션 직접 설정'));
    await user.clear(screen.getByLabelText('Train 종료 시각'));
    await user.type(screen.getByLabelText('Train 종료 시각'), '2018-04-01T04:49:00');
    await user.clear(screen.getByLabelText('Valid 종료 시각'));
    await user.type(screen.getByLabelText('Valid 종료 시각'), '2018-04-01T03:29:00');
    await user.click(screen.getByRole('button', { name: '학습 시작' }));
    expect(await screen.findByText(/Train 종료와 Valid 종료를 올바른 ISO/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Train 종료 시각'));
    await user.type(screen.getByLabelText('Train 종료 시각'), '2018-04-01T01:00:00');
    await user.click(screen.getByRole('button', { name: '학습 시작' }));
    expect(await screen.findByText(/두 경계의 시간대 표기를 CSV와 같게/)).toBeInTheDocument();
    expect(mocks.api.createRun).not.toHaveBeenCalled();
  });

  it('과거 LightGBM 기록도 보존하고 모델 선택과 Test 요청은 확인 후에만 보낸다', async () => {
    let run: RunDetail = structuredClone(DEMO_RUN_DETAIL);

    run.run.selected_model = null;
    mocks.useApp.mockReturnValue(context(run.run.id));
    mocks.api.run.mockImplementation(async () => structuredClone(run));
    mocks.api.selectModel.mockImplementation(async (_id, key) => {
      run.run.selected_model = key;
      return structuredClone(run);
    });
    mocks.api.evaluate.mockImplementation(async () => {
      run.run.evaluation_status = 'completed';
      return { ...structuredClone(DEMO_EVALUATION), model_key: 'lightgbm' };
    });
    const user = userEvent.setup();

    mount();
    await screen.findByLabelText('이전 실행의 모델');
    expect(screen.getByRole('option', { name: 'LightGBM' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('이전 실행의 모델'), 'lightgbm');
    expect(mocks.api.selectModel).not.toHaveBeenCalled();
    expect(mocks.api.evaluate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '마지막 데이터로 확인' }));
    const dialog = await screen.findByRole('dialog', { name: '마지막 데이터로 확인할까요?' });

    expect(mocks.api.evaluate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '최종 확인 시작' }));
    await waitFor(() => expect(mocks.api.selectModel).toHaveBeenCalledWith(run.run.id, 'lightgbm'));
    await waitFor(() => expect(mocks.api.evaluate).toHaveBeenCalledExactlyOnceWith(run.run.id));
    expect(
      await screen.findByText(/최종 평가를 시작한 실행은 모델과 설정을 바꿀 수 없어요/),
    ).toBeInTheDocument();
  });

  it('모델 변경 뒤 늦게 도착한 자동 설정을 적용하지 않는다', async () => {
    let resolvePlan: (value: ReturnType<typeof plan>) => void = () => {};

    mocks.prepareTraining.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    );
    const user = userEvent.setup();

    mount();
    await waitFor(() => expect(mocks.prepareTraining).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('radio', { name: /AutoEncoder/ }));
    resolvePlan(plan('xgboost'));
    await waitFor(() => expect(screen.queryByText('210행')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '학습 시작' })).toBeDisabled();
  });
});
