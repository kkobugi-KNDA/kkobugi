import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { ReviewHistory, ReviewRecord } from '../lib/assessment-api';
import type { SavedObservation } from '../lib/review-api';
import ReviewWorkflowPanel, { matchingObservations } from './ReviewWorkflowPanel';
import { csvTimestampToNumber, type SelectedRange } from './TimeSeriesChart';

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  api: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    complete: vi.fn(),
    reopen: vi.fn(),
    history: vi.fn(),
  },
}));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));
vi.mock('../lib/assessment-api', () => ({ assessmentApi: mocks.api }));

const actor = { id: 1, username: 'worker', display_name: '점검자' };

const datasetId = '1'.repeat(32);

const observation: SavedObservation = {
  id: '2'.repeat(32),
  dataset_id: datasetId,
  channel: 'sensor_04',
  run_id: null,
  model_key: null,
  start_time: '2026-11-09T00:10:00',
  end_time: '2026-11-09T00:11:00',
  content: '누수 흔적을 처음 확인함',
  location: '현장 확인 위치',
  judgment: 'needs_check',
  revision: 1,
  created_at: 10,
  updated_at: 10,
  author: actor,
  last_editor: actor,
};

const range: SelectedRange = {
  start: {
    timestamp: observation.start_time,
    time: csvTimestampToNumber(observation.start_time),
    value: 10,
    label: 'normal',
  },
  end: {
    timestamp: observation.end_time,
    time: csvTimestampToNumber(observation.end_time),
    value: 11,
    label: 'abnormal',
  },
};

function record(changes: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: '3'.repeat(32),
    dataset_id: datasetId,
    channel: observation.channel,
    start_time: range.start.timestamp,
    end_time: range.end.timestamp,
    conclusion: '처음 저장한 검토 내용',
    judgment: 'needs_check',
    status: 'in_progress',
    revision: 1,
    created_at: 100,
    updated_at: 100,
    author: actor,
    last_editor: actor,
    completed_at: null,
    completed_by: null,
    evidence: { model_result: null, observations: [structuredClone(observation)] },
    ...changes,
  };
}

const props = {
  datasetId,
  channel: observation.channel,
  selection: range,
  modelResult: null,
  observations: [observation],
  mode: 'live' as const,
};

function list(items: ReviewRecord[] = []) {
  return { items, total: items.length, offset: 0, limit: 20 };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useApp.mockReturnValue({ user: actor });
  mocks.api.list.mockResolvedValue(list());
  mocks.api.get.mockResolvedValue(record());
  mocks.api.create.mockResolvedValue(record());
});

async function openSaved(saved = record()) {
  mocks.api.list.mockResolvedValue(list([saved]));
  mocks.api.get.mockResolvedValue(saved);
  render(<ReviewWorkflowPanel {...props} />);
  await userEvent.click(
    await screen.findByRole('button', { name: `검토 열기: ${saved.conclusion || '미작성 검토'}` }),
  );
  return screen.findByRole('dialog', { name: '검토 기록' });
}

describe('검토 저장·완료·다시 열기', () => {
  it('선택한 구간과 명시한 관찰 버전으로 저장하고 별도 버튼에서만 완료한다', async () => {
    const user = userEvent.setup();

    mocks.api.complete.mockResolvedValue(
      record({ status: 'completed', revision: 2, completed_at: 110, completed_by: actor }),
    );
    render(<ReviewWorkflowPanel {...props} />);
    await user.click(screen.getByRole('button', { name: '선택한 구간 검토하기' }));
    const dialog = await screen.findByRole('dialog', { name: '검토 기록 만들기' });

    await user.type(
      within(dialog).getByLabelText('검토 내용'),
      '누수 흔적을 확인했으나 원인은 보류함',
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: `${observation.content} · 수정 1` }),
    );
    await user.click(within(dialog).getByRole('button', { name: '검토 초안 저장' }));
    await waitFor(() => expect(mocks.api.create).toHaveBeenCalledTimes(1));
    expect(mocks.api.create).toHaveBeenCalledWith({
      dataset_id: datasetId,
      channel: observation.channel,
      start_time: range.start.timestamp,
      end_time: range.end.timestamp,
      conclusion: '누수 흔적을 확인했으나 원인은 보류함',
      judgment: 'needs_check',
      model_result: null,
      observations: [{ observation_id: observation.id, revision: 1 }],
    });
    expect(mocks.api.complete).not.toHaveBeenCalled();
    const detail = await screen.findByRole('dialog', { name: '검토 기록' });

    await user.click(within(detail).getByRole('button', { name: '검토 완료' }));
    await waitFor(() => expect(mocks.api.complete).toHaveBeenCalledWith(record().id, 1));
    expect(within(detail).getByLabelText('검토 내용')).toBeDisabled();
    expect(within(detail).getByLabelText('직접 내린 판단')).toHaveValue('needs_check');
  });

  it('완료한 기록은 사유를 남겨 다시 열고 현재 수정 번호로 저장한다', async () => {
    const user = userEvent.setup();

    const completed = record({
      status: 'completed',
      revision: 2,
      completed_at: 110,
      completed_by: actor,
    });

    mocks.api.reopen.mockResolvedValue(record({ revision: 3 }));
    mocks.api.patch.mockResolvedValue(record({ revision: 4, conclusion: '다시 확인하고 수정함' }));
    const dialog = await openSaved(completed);

    expect(within(dialog).getByLabelText('검토 내용')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '다시 열기' })).toBeDisabled();
    expect(mocks.api.patch).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('다시 여는 이유'), '현장 재확인 내용을 반영');
    await user.click(within(dialog).getByRole('button', { name: '다시 열기' }));
    await waitFor(() => expect(within(dialog).getByLabelText('검토 내용')).toBeEnabled());
    expect(mocks.api.reopen).toHaveBeenCalledWith(completed.id, 2, '현장 재확인 내용을 반영');
    await user.clear(within(dialog).getByLabelText('검토 내용'));
    await user.type(within(dialog).getByLabelText('검토 내용'), '다시 확인하고 수정함');
    expect(within(dialog).getByRole('button', { name: '검토 완료' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await waitFor(() =>
      expect(mocks.api.patch).toHaveBeenCalledWith(completed.id, {
        revision: 3,
        conclusion: '다시 확인하고 수정함',
        judgment: 'needs_check',
      }),
    );
    expect(mocks.api.patch.mock.calls[0][1]).not.toHaveProperty('observations');
  });

  it.each([
    record({ conclusion: '' }),
    record({ evidence: { model_result: null, observations: [] } }),
  ])('내용 또는 근거가 없는 초안은 완료할 수 없다', async (saved) => {
    const dialog = await openSaved(saved);

    expect(within(dialog).getByRole('button', { name: '검토 완료' })).toBeDisabled();
    expect(mocks.api.complete).not.toHaveBeenCalled();
  });

  it('입력창을 연 뒤 관찰 목록이 바뀌어도 체크했던 수정 번호를 교체하지 않는다', async () => {
    const user = userEvent.setup();

    const view = render(<ReviewWorkflowPanel {...props} />);

    await user.click(screen.getByRole('button', { name: '선택한 구간 검토하기' }));
    const dialog = await screen.findByRole('dialog', { name: '검토 기록 만들기' });

    await user.click(
      within(dialog).getByRole('checkbox', { name: `${observation.content} · 수정 1` }),
    );
    view.rerender(
      <ReviewWorkflowPanel
        {...props}
        observations={[{ ...observation, revision: 2, content: '이후에 바뀐 관찰' }]}
      />,
    );
    expect(
      within(dialog).getByRole('checkbox', { name: `${observation.content} · 수정 1` }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: '검토 초안 저장' }));
    await waitFor(() => expect(mocks.api.create).toHaveBeenCalledTimes(1));
    expect(mocks.api.create.mock.calls[0][0].observations).toEqual([
      { observation_id: observation.id, revision: 1 },
    ]);
  });

  it('근거 없이 저장한 초안에도 관찰을 나중에 연결한 뒤 완료할 수 있다', async () => {
    const user = userEvent.setup();

    const draft = record({ evidence: { model_result: null, observations: [] } });

    mocks.api.patch.mockResolvedValue(record({ revision: 2 }));
    mocks.api.complete.mockResolvedValue(
      record({ revision: 3, status: 'completed', completed_at: 120, completed_by: actor }),
    );
    const dialog = await openSaved(draft);

    expect(within(dialog).getByRole('button', { name: '검토 완료' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '근거 수정' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: `근거 관찰 ${observation.content} · 수정 1` }),
    );
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await waitFor(() =>
      expect(mocks.api.patch).toHaveBeenCalledWith(draft.id, {
        revision: 1,
        conclusion: draft.conclusion,
        judgment: 'needs_check',
        observations: [{ observation_id: observation.id, revision: 1 }],
      }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '검토 완료' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: '검토 완료' }));
    await waitFor(() => expect(mocks.api.complete).toHaveBeenCalledWith(draft.id, 2));
  });

  it('과거 관찰 버전을 유지하고 새 버전을 직접 선택한 경우에만 바꾼다', async () => {
    const user = userEvent.setup();

    const latest = { ...observation, revision: 2, content: '새로 확인한 관찰' };

    mocks.api.list.mockResolvedValue(list([record()]));
    mocks.api.patch
      .mockResolvedValueOnce(record({ revision: 2 }))
      .mockResolvedValueOnce(
        record({ revision: 3, evidence: { model_result: null, observations: [latest] } }),
      );
    render(<ReviewWorkflowPanel {...props} observations={[latest]} />);
    await user.click(
      await screen.findByRole('button', { name: `검토 열기: ${record().conclusion}` }),
    );
    const dialog = await screen.findByRole('dialog', { name: '검토 기록' });

    await user.click(within(dialog).getByRole('button', { name: '근거 수정' }));
    expect(
      within(dialog).getByRole('checkbox', { name: `근거 관찰 ${observation.content} · 수정 1` }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: `근거 관찰 ${latest.content} · 수정 2` }),
    ).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await waitFor(() => expect(mocks.api.patch).toHaveBeenCalledTimes(1));
    expect(mocks.api.patch.mock.calls[0][1].observations).toEqual([
      { observation_id: observation.id, revision: 1 },
    ]);
    await user.click(within(dialog).getByRole('button', { name: '근거 수정' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: `근거 관찰 ${latest.content} · 수정 2` }),
    );
    expect(
      within(dialog).getByRole('checkbox', { name: `근거 관찰 ${observation.content} · 수정 1` }),
    ).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await waitFor(() => expect(mocks.api.patch).toHaveBeenCalledTimes(2));
    expect(mocks.api.patch.mock.calls[1][1].observations).toEqual([
      { observation_id: latest.id, revision: 2 },
    ]);
  });

  it('현재 모델 연결과 기존 근거 해제는 명시적인 선택 후에만 전송한다', async () => {
    const user = userEvent.setup();

    const model = {
      run_id: '4'.repeat(32),
      model_key: 'lightgbm' as const,
      split: 'validation' as const,
    };

    mocks.api.list.mockResolvedValue(list([record()]));
    mocks.api.patch.mockResolvedValue(record({ revision: 2 }));
    render(<ReviewWorkflowPanel {...props} modelResult={model} />);
    await user.click(
      await screen.findByRole('button', { name: `검토 열기: ${record().conclusion}` }),
    );
    const dialog = await screen.findByRole('dialog', { name: '검토 기록' });

    await user.click(within(dialog).getByRole('button', { name: '근거 수정' }));
    await user.click(within(dialog).getByRole('radio', { name: '현재 선택한 모델 결과 연결' }));
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await waitFor(() => expect(mocks.api.patch).toHaveBeenCalledTimes(1));
    expect(mocks.api.patch.mock.calls[0][1].model_result).toEqual(model);
    await user.click(within(dialog).getByRole('button', { name: '근거 수정' }));
    await user.click(within(dialog).getByRole('radio', { name: '모델 연결 해제' }));
    await user.click(
      within(dialog).getByRole('checkbox', { name: `근거 관찰 ${observation.content} · 수정 1` }),
    );
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await waitFor(() => expect(mocks.api.patch).toHaveBeenCalledTimes(2));
    expect(mocks.api.patch.mock.calls[1][1]).toMatchObject({
      model_result: null,
      observations: [],
    });
  });
});

describe('충돌·문맥 변경·저장한 이력', () => {
  it('409면 입력을 그대로 남기며 최신 내용을 명시적으로 불러오기 전에는 재시도하지 않는다', async () => {
    const user = userEvent.setup();

    mocks.api.patch.mockRejectedValue(
      new ApiError('먼저 저장된 수정이 있습니다.', 409, 'REVIEW_CONFLICT'),
    );
    const dialog = await openSaved();

    await user.clear(within(dialog).getByLabelText('검토 내용'));
    await user.type(within(dialog).getByLabelText('검토 내용'), '내가 입력하던 내용');
    await user.click(within(dialog).getByRole('button', { name: '검토 수정 저장' }));
    await within(dialog).findByText('먼저 저장된 수정이 있습니다.');
    expect(within(dialog).getByLabelText('검토 내용')).toHaveValue('내가 입력하던 내용');
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    expect(mocks.api.patch).toHaveBeenCalledTimes(1);
    mocks.api.get.mockResolvedValue(record({ conclusion: '서버에 먼저 저장된 내용', revision: 3 }));
    await user.click(within(dialog).getByRole('button', { name: '최신 검토 불러오기' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('검토 내용')).toHaveValue('서버에 먼저 저장된 내용'),
    );
    expect(mocks.api.patch).toHaveBeenCalledTimes(1);
  });

  it('자료를 바꾼 뒤 도착한 이전 자료의 상세 응답은 표시하지 않는다', async () => {
    let resolveDetail!: (value: ReviewRecord) => void;

    mocks.api.list.mockResolvedValue(list([record()]));
    mocks.api.get.mockReturnValue(
      new Promise<ReviewRecord>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    const view = render(<ReviewWorkflowPanel {...props} />);

    await userEvent.click(
      await screen.findByRole('button', { name: '검토 열기: 처음 저장한 검토 내용' }),
    );
    mocks.api.list.mockResolvedValue(list());
    view.rerender(<ReviewWorkflowPanel {...props} datasetId={'9'.repeat(32)} />);
    await act(async () => resolveDetail(record()));
    expect(screen.queryByRole('dialog', { name: '검토 기록' })).not.toBeInTheDocument();
    expect(screen.queryByText('처음 저장한 검토 내용')).not.toBeInTheDocument();
  });

  it('완료 시점의 전체 스냅샷과 이전 관찰 버전을 이력에서 확인할 수 있다', async () => {
    const user = userEvent.setup();

    const completed = record({
      status: 'completed',
      revision: 2,
      completed_at: 110,
      completed_by: actor,
    });

    const history: ReviewHistory = {
      review_id: completed.id,
      total: 2,
      offset: 0,
      limit: 20,
      items: [
        {
          revision: 2,
          action: 'completed',
          reason: '',
          changed_at: 110,
          changed_by: actor,
          snapshot: completed,
        },
        {
          revision: 1,
          action: 'created',
          reason: '',
          changed_at: 100,
          changed_by: actor,
          snapshot: record({ conclusion: '과거에 기록한 최초 내용' }),
        },
      ],
    };

    mocks.api.history.mockResolvedValue(history);
    const dialog = await openSaved(completed);

    await user.click(within(dialog).getByRole('button', { name: '수정 이력 보기' }));
    await waitFor(() =>
      expect(mocks.api.history).toHaveBeenCalledWith(completed.id, 0, expect.any(AbortSignal)),
    );
    await user.click(await within(dialog).findByText(/수정 1 당시 내용 보기/));
    expect(within(dialog).getByText('과거에 기록한 최초 내용')).toBeVisible();
    expect(within(dialog).getAllByText('누수 흔적을 처음 확인함').length).toBeGreaterThan(1);
  });

  it('미리보기에는 저장 API를 호출하지 않는다', () => {
    render(<ReviewWorkflowPanel {...props} mode="demo" />);
    expect(screen.getByRole('button', { name: '선택한 구간 검토하기' })).toBeDisabled();
    expect(screen.getByText(/미리보기에서는 검토를 저장하지 않습니다/)).toBeInTheDocument();
    expect(mocks.api.list).not.toHaveBeenCalled();
    expect(mocks.api.create).not.toHaveBeenCalled();
  });

  it('아직 불러오지 않은 관찰이 있으면 전체가 없는 것처럼 표시하지 않는다', async () => {
    render(<ReviewWorkflowPanel {...props} observations={[]} observationsTotal={120} />);
    await userEvent.click(screen.getByRole('button', { name: '선택한 구간 검토하기' }));
    expect(await screen.findByText(/관찰 120개 중 0개를 불러왔어요/)).toBeInTheDocument();
  });
});

describe('근거로 연결할 관찰의 시간 구간', () => {
  it('같은 채널이며 양끝을 포함해 겹치는 저장본만 남긴다', () => {
    const otherChannel = { ...observation, id: '4'.repeat(32), channel: 'sensor_10' };

    const later = {
      ...observation,
      id: '5'.repeat(32),
      start_time: '2026-11-09T00:12:00',
      end_time: '2026-11-09T00:13:00',
    };

    expect(
      matchingObservations([observation, otherChannel, later], observation.channel, range),
    ).toEqual([observation]);
    expect(matchingObservations([observation], observation.channel, null)).toEqual([]);
  });
});
