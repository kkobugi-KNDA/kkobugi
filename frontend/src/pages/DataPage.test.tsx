import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DataPage from './DataPage';
import { DEMO_DATASET_DETAIL } from '../data/demo';

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  api: { dataset: vi.fn(), upload: vi.fn(), deletedDatasets: vi.fn() },
  selectDataset: vi.fn(),
  registerDataset: vi.fn(),
  deleteDataset: vi.fn(),
  restoreDataset: vi.fn(),
  refreshDatasets: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));
vi.mock('../lib/api', () => ({
  api: mocks.api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : '요청 오류'),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.refreshDatasets.mockResolvedValue(undefined);
  mocks.deleteDataset.mockResolvedValue(undefined);
  mocks.restoreDataset.mockResolvedValue(undefined);
  mocks.api.deletedDatasets.mockResolvedValue({ items: [], total: 0 });
  mocks.useApp.mockReturnValue({
    mode: 'live',
    datasets: [],
    datasetsLoading: false,
    selectedDatasetId: null,
    setSelectedDatasetId: mocks.selectDataset,
    refreshDatasets: mocks.refreshDatasets,
    registerDataset: mocks.registerDataset,
    deleteDataset: mocks.deleteDataset,
    restoreDataset: mocks.restoreDataset,
    toast: mocks.toast,
  });
});
function mount() {
  return render(
    <MemoryRouter>
      <DataPage />
    </MemoryRouter>,
  );
}

describe('CSV 등록과 검사 결과', () => {
  it('원본 File과 사용자가 정한 역할 열·0/1 라벨을 multipart로 보내고 실제 검사 결과를 표시한다', async () => {
    const result = structuredClone(DEMO_DATASET_DETAIL);
    result.dataset.filename = 'prepared.csv';
    result.dataset.status = 'needs_review';
    result.inspection.is_valid = false;
    result.inspection.issues = [
      {
        code: 'MISSING_VALUE',
        column: 'sensor_04',
        count: 2,
        severity: 'error',
        message: 'sensor_04에 결측 셀이 있어요.',
      },
    ];
    mocks.api.upload.mockResolvedValue(result);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getAllByRole('button', { name: 'CSV 등록' })[0]);
    const modal = await screen.findByRole('dialog', { name: 'CSV 등록' });
    const file = new File(
      ['measured_at,sensor_04,LABEL\n2018-04-01T00:00:00,12,0\n'],
      'prepared.csv',
      { type: 'text/csv' },
    );
    await user.upload(within(modal).getByLabelText('등록할 CSV 파일'), file);
    await user.clear(within(modal).getByLabelText('시각 열'));
    await user.type(within(modal).getByLabelText('시각 열'), 'measured_at');
    await user.clear(within(modal).getByLabelText('라벨 열'));
    await user.type(within(modal).getByLabelText('라벨 열'), 'LABEL');
    await user.click(within(modal).getByRole('button', { name: 'Normal=0 / Abnormal=1 적용' }));
    expect(mocks.api.upload).not.toHaveBeenCalled();
    await user.click(within(modal).getByRole('button', { name: '등록하고 검사' }));
    await waitFor(() => expect(mocks.api.upload).toHaveBeenCalledTimes(1));
    const form = mocks.api.upload.mock.calls[0][0] as FormData;
    expect(form.get('file')).toBe(file);
    expect(form.get('timestamp_column')).toBe('measured_at');
    expect(form.get('label_column')).toBe('LABEL');
    expect(form.get('normal_label')).toBe('0');
    expect(form.get('abnormal_label')).toBe('1');
    expect(await screen.findByText('입력 확인 필요')).toBeInTheDocument();
    expect(screen.getByText('sensor_04에 결측 셀이 있어요.')).toBeInTheDocument();
    expect(mocks.registerDataset).toHaveBeenCalledWith(result.dataset);
    expect(mocks.refreshDatasets).toHaveBeenCalledTimes(1);
  });

  it('서버가 거부하면 입력과 파일을 남겨두고 예시 CSV로 대체하지 않는다', async () => {
    mocks.api.upload.mockRejectedValue(new Error('필수 열 LABEL이 없어요.'));
    const user = userEvent.setup();
    mount();
    await user.click(screen.getAllByRole('button', { name: 'CSV 등록' })[0]);
    const modal = await screen.findByRole('dialog', { name: 'CSV 등록' });
    await user.upload(
      within(modal).getByLabelText('등록할 CSV 파일'),
      new File(['timestamp,value\n2018-04-01T00:00:00,1'], 'missing-label.csv', {
        type: 'text/csv',
      }),
    );
    await user.click(within(modal).getByRole('button', { name: '등록하고 검사' }));
    expect(await within(modal).findByText('필수 열 LABEL이 없어요.')).toBeInTheDocument();
    expect(within(modal).getByText('missing-label.csv')).toBeInTheDocument();
    expect(within(modal).getByLabelText('시각 열')).toHaveValue('timestamp');
    expect(mocks.selectDataset).not.toHaveBeenCalled();
    expect(mocks.registerDataset).not.toHaveBeenCalled();
    expect(mocks.refreshDatasets).not.toHaveBeenCalled();
    expect(screen.queryByText('pump-demo.csv')).not.toBeInTheDocument();
  });
});

describe('CSV 삭제와 복원', () => {
  function selectedDataset() {
    mocks.useApp.mockReturnValue({
      ...mocks.useApp(),
      datasets: [DEMO_DATASET_DETAIL.dataset],
      selectedDatasetId: DEMO_DATASET_DETAIL.dataset.id,
    });
    mocks.api.dataset.mockResolvedValue(DEMO_DATASET_DETAIL);
  }

  it('파일 이름과 기록 보존을 먼저 확인하고 취소하면 삭제하지 않는다', async () => {
    selectedDataset();

    const user = userEvent.setup();

    mount();
    await user.click(
      await screen.findByRole('button', { name: `${DEMO_DATASET_DETAIL.dataset.filename} 삭제` }),
    );

    const modal = screen.getByRole('dialog', { name: 'CSV를 삭제할까요?' });

    expect(within(modal).getByText(DEMO_DATASET_DETAIL.dataset.filename)).toBeInTheDocument();
    expect(
      within(modal).getByText(/원본 파일과 기존 학습·판단·점검 기록은 보존/),
    ).toBeInTheDocument();
    expect(mocks.deleteDataset).not.toHaveBeenCalled();
    await user.click(within(modal).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.deleteDataset).not.toHaveBeenCalled();
  });

  it('확인한 CSV만 삭제하고 되돌리기 버튼으로 같은 파일을 복원한다', async () => {
    selectedDataset();

    const user = userEvent.setup();

    mount();
    await user.click(
      await screen.findByRole('button', { name: `${DEMO_DATASET_DETAIL.dataset.filename} 삭제` }),
    );
    await user.click(screen.getByRole('button', { name: '목록에서 삭제' }));
    await waitFor(() =>
      expect(mocks.deleteDataset).toHaveBeenCalledWith(DEMO_DATASET_DETAIL.dataset.id),
    );
    await user.click(await screen.findByRole('button', { name: '삭제 취소' }));
    expect(mocks.restoreDataset).toHaveBeenCalledWith(DEMO_DATASET_DETAIL.dataset.id);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '삭제 취소' })).not.toBeInTheDocument(),
    );
  });

  it('삭제 실패 시 확인창과 선택한 CSV를 유지하고 오류를 보여준다', async () => {
    selectedDataset();
    mocks.deleteDataset.mockRejectedValue(new Error('CSV를 삭제하지 못했어요.'));

    const user = userEvent.setup();

    mount();
    await user.click(
      await screen.findByRole('button', { name: `${DEMO_DATASET_DETAIL.dataset.filename} 삭제` }),
    );
    await user.click(screen.getByRole('button', { name: '목록에서 삭제' }));

    const modal = screen.getByRole('dialog', { name: 'CSV를 삭제할까요?' });

    expect(await within(modal).findByRole('alert')).toHaveTextContent('CSV를 삭제하지 못했어요.');
    expect(mocks.selectDataset).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '삭제 취소' })).not.toBeInTheDocument();
  });

  it('페이지를 다시 방문해도 삭제한 CSV 목록에서 복원할 수 있다', async () => {
    mocks.api.deletedDatasets.mockResolvedValue({ items: [DEMO_DATASET_DETAIL.dataset], total: 1 });

    const user = userEvent.setup();

    mount();
    await user.click(screen.getByRole('button', { name: '삭제한 CSV' }));

    const modal = screen.getByRole('dialog', { name: '삭제한 CSV' });

    await user.click(
      await within(modal).findByRole('button', {
        name: `${DEMO_DATASET_DETAIL.dataset.filename} 복원`,
      }),
    );
    expect(mocks.restoreDataset).toHaveBeenCalledWith(DEMO_DATASET_DETAIL.dataset.id);
    expect(await within(modal).findByText('삭제한 CSV가 없어요')).toBeInTheDocument();
  });

  it('복원 실패 시 삭제 목록과 다시 시도할 버튼을 유지한다', async () => {
    mocks.api.deletedDatasets.mockResolvedValue({ items: [DEMO_DATASET_DETAIL.dataset], total: 1 });
    mocks.restoreDataset.mockRejectedValue(new Error('복원 서버 오류'));

    const user = userEvent.setup();

    mount();
    await user.click(screen.getByRole('button', { name: '삭제한 CSV' }));

    const modal = screen.getByRole('dialog', { name: '삭제한 CSV' });

    await user.click(
      await within(modal).findByRole('button', {
        name: `${DEMO_DATASET_DETAIL.dataset.filename} 복원`,
      }),
    );
    expect(await within(modal).findByRole('alert')).toHaveTextContent('복원 서버 오류');
    expect(
      within(modal).getByRole('button', { name: `${DEMO_DATASET_DETAIL.dataset.filename} 복원` }),
    ).toBeEnabled();
  });

  it('미리보기에서는 실제 CSV 삭제와 삭제 목록 접근을 막는다', async () => {
    selectedDataset();
    mocks.useApp.mockReturnValue({ ...mocks.useApp(), mode: 'demo' });
    mount();
    expect(
      await screen.findByRole('button', { name: `${DEMO_DATASET_DETAIL.dataset.filename} 삭제` }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: '삭제한 CSV' })).toBeDisabled();
  });
});
