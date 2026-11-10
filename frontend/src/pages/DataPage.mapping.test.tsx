import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataPage from './DataPage';
import { inspectCsvText, type CsvMappingPreview } from '../lib/csv-mapping';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), isExpert: false }));

vi.mock('../lib/csv-mapping', async (original) => ({
  ...(await original<typeof import('../lib/csv-mapping')>()),
  inspectCsvFile: mocks.readFile,
}));
vi.mock('../context/ExpertiseContext', () => ({
  useExpertise: () => ({ isExpert: mocks.isExpert }),
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    mode: 'live',
    datasets: [],
    datasetsLoading: false,
    selectedDatasetId: null,
    setSelectedDatasetId: vi.fn(),
    toast: vi.fn(),
  }),
}));

beforeEach(() => {
  mocks.isExpert = false;
  mocks.readFile.mockReset();
});

async function openUpload() {
  const user = userEvent.setup();

  render(
    <MemoryRouter>
      <DataPage />
    </MemoryRouter>,
  );
  await user.click(screen.getAllByRole('button', { name: 'CSV 등록' })[0]);

  const modal = screen.getByRole('dialog', { name: 'CSV 등록' });

  return { user, modal };
}

describe('CSV 입력 자동 채우기와 설명', () => {
  it('Pro는 쉬운 말, Pro+는 요청한 라벨링 용어를 표시한다', async () => {
    mocks.isExpert = true;

    const { modal } = await openUpload();

    expect(within(modal).getByLabelText('정상 라벨링 값')).toHaveValue('');
    expect(within(modal).getByLabelText('이상 라벨링 값')).toHaveValue('');
    expect(within(modal).getByLabelText('라벨 컬럼')).toHaveValue('');
    expect(within(modal).getByText('포부기의 안내')).toBeInTheDocument();
  });

  it('파일을 바꾼 뒤 늦게 읽힌 이전 파일 값은 채우지 않는다', async () => {
    let completeOld!: (value: CsvMappingPreview) => void;

    mocks.readFile.mockReturnValueOnce(
      new Promise<CsvMappingPreview>((resolve) => {
        completeOld = resolve;
      }),
    );
    mocks.readFile.mockResolvedValueOnce(
      inspectCsvText('datetime,anomaly\n2020-01-01,0.0\n2020-01-02,1.0\n'),
    );

    const { user, modal } = await openUpload();

    await user.upload(
      within(modal).getByLabelText('등록할 CSV 파일'),
      new File(['old'], 'old.csv'),
    );
    await user.upload(
      within(modal).getByLabelText('등록할 CSV 파일'),
      new File(['new'], 'new.csv'),
    );
    await waitFor(() =>
      expect(within(modal).getByLabelText('정상으로 표시된 값')).toHaveValue('0.0'),
    );
    await act(async () =>
      completeOld(inspectCsvText('timestamp,label\n2020-01-01,NORMAL\n2020-01-02,ABNORMAL\n')),
    );
    expect(within(modal).getByLabelText('시간이 기록된 열')).toHaveValue('datetime');
    expect(within(modal).getByLabelText('이상으로 표시된 값')).toHaveValue('1.0');
    expect(mocks.readFile.mock.calls[0][1].aborted).toBe(true);
  });

  it('읽는 중 직접 입력한 값은 나중의 자동 검사로 덮어쓰지 않는다', async () => {
    let complete!: (value: CsvMappingPreview) => void;

    mocks.readFile.mockReturnValueOnce(
      new Promise<CsvMappingPreview>((resolve) => {
        complete = resolve;
      }),
    );

    const { user, modal } = await openUpload();

    await user.upload(
      within(modal).getByLabelText('등록할 CSV 파일'),
      new File(['manual'], 'manual.csv'),
    );
    await user.type(within(modal).getByLabelText('시간이 기록된 열'), 'manual_time');
    await user.type(within(modal).getByLabelText('정상으로 표시된 값'), 'GOOD');
    await act(async () =>
      complete(inspectCsvText('timestamp,label\n2020-01-01,normal\n2020-01-02,abnormal\n')),
    );
    expect(within(modal).getByLabelText('시간이 기록된 열')).toHaveValue('manual_time');
    expect(within(modal).getByLabelText('정상으로 표시된 값')).toHaveValue('GOOD');
    expect(within(modal).getByLabelText('이상으로 표시된 값')).toHaveValue('abnormal');
  });

  it('여러 존은 사용자 선택을 기다리고 열을 바꾸면 해당 원본 값으로 다시 제안한다', async () => {
    mocks.readFile.mockResolvedValue(
      inspectCsvText(
        'timestamp,Z3_LABEL,Z4_LABEL\n2020-01-01,0.0,NORMAL\n2020-01-02,1.0,ABNORMAL\n',
      ),
    );

    const { user, modal } = await openUpload();

    await user.upload(
      within(modal).getByLabelText('등록할 CSV 파일'),
      new File(['zones'], 'zones.csv'),
    );
    await user.click(await within(modal).findByRole('button', { name: 'Z3_LABEL' }));
    expect(within(modal).getByLabelText('정상으로 표시된 값')).toHaveValue('0.0');
    expect(within(modal).getByLabelText('이상으로 표시된 값')).toHaveValue('1.0');
    await user.click(within(modal).getByRole('button', { name: 'Z4_LABEL' }));
    expect(within(modal).getByLabelText('정상으로 표시된 값')).toHaveValue('NORMAL');
    expect(within(modal).getByLabelText('이상으로 표시된 값')).toHaveValue('ABNORMAL');
  });
});
