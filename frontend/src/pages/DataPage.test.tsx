import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DataPage from './DataPage';
import { DEMO_DATASET_DETAIL } from '../data/demo';

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  api: { dataset: vi.fn(), upload: vi.fn() },
  selectDataset: vi.fn(),
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
  mocks.useApp.mockReturnValue({
    mode: 'live',
    datasets: [],
    datasetsLoading: false,
    selectedDatasetId: null,
    setSelectedDatasetId: mocks.selectDataset,
    refreshDatasets: mocks.refreshDatasets,
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
    expect(mocks.selectDataset).toHaveBeenCalledWith(result.dataset.id);
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
    expect(mocks.refreshDatasets).not.toHaveBeenCalled();
    expect(screen.queryByText('pump-demo.csv')).not.toBeInTheDocument();
  });
});
