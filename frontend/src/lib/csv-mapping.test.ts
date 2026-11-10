import { describe, expect, it } from 'vitest';
import { inspectCsvFile, inspectCsvText, suggestLabelValues } from './csv-mapping';

describe('원본 CSV 자동 연결 제안', () => {
  it('BOM과 SKAB 세미콜론 구분자를 읽고 0.0/1.0을 그대로 유지한다', () => {
    const preview = inspectCsvText(
      '\uFEFFdatetime;value;anomaly;changepoint\n2020-01-01,00:00;5;0.0;0\n2020-01-02,00:00;6;1.0;1\n',
    );

    expect(preview.timestampColumn).toBe('datetime');
    expect(preview.labelColumn).toBe('anomaly');
    expect(preview.delimiter).toBe(';');
    expect(suggestLabelValues(preview.values.anomaly)).toMatchObject({
      normal: '0.0',
      abnormal: '1.0',
    });
  });

  it('대소문자를 바꾸지 않고 정상·이상 문자열을 연결한다', () => {
    expect(suggestLabelValues(['Normal', 'ABNORMAL'])).toMatchObject({
      normal: 'Normal',
      abnormal: 'ABNORMAL',
    });
  });

  it('여러 존 라벨 중 하나를 임의로 선택하지 않는다', () => {
    const preview = inspectCsvText(
      'timestamp,value,Z3__STAT_LABEL,Z4__STAT_LABEL\n2020-01-01,5,0,1\n',
    );

    expect(preview.labelColumn).toBe('');
    expect(preview.labelCandidates).toEqual(['Z3__STAT_LABEL', 'Z4__STAT_LABEL']);
  });

  it('펌프의 전처리 label 열을 원래 machine_status보다 우선한다', () => {
    const preview = inspectCsvText(
      'timestamp,value,machine_status,label\n2020-01-01,5,NORMAL,normal\n2020-01-02,6,BROKEN,abnormal\n2020-01-03,5,RECOVERING,abnormal\n',
    );

    expect(preview.labelColumn).toBe('label');
    expect(preview.labelCandidates).toEqual(['machine_status', 'label']);
    expect(suggestLabelValues(preview.values.label)).toMatchObject({
      normal: 'normal',
      abnormal: 'abnormal',
    });
  });

  it('명시적인 정답 열이 두 개면 선택을 기다리고 원래 상태 열만 있으면 후보로 둔다', () => {
    expect(inspectCsvText('timestamp,label,anomaly\n2020-01-01,0,0\n').labelColumn).toBe('');

    const raw = inspectCsvText(
      'timestamp,machine_status\n2020-01-01,NORMAL\n2020-01-02,BROKEN\n2020-01-03,RECOVERING\n',
    );

    expect(raw.labelColumn).toBe('machine_status');
    expect(suggestLabelValues(raw.values.machine_status).abnormal).toBe('');
  });

  it('빈도·모르는 상태·소수점 표현 혼합으로 정상·이상을 추측하지 않는다', () => {
    expect(suggestLabelValues(['A', 'B'])).toMatchObject({ normal: '', abnormal: '' });
    expect(suggestLabelValues(['0', '0.0', '1.0'])).toMatchObject({ normal: '', abnormal: '' });
    expect(suggestLabelValues(['NORMAL', 'BROKEN', 'RECOVERING'])).toMatchObject({
      normal: 'NORMAL',
      abnormal: '',
    });
  });

  it('정상만 본 표본에서는 보지 못한 이상 값을 만들어 넣지 않는다', () => {
    expect(suggestLabelValues(['NORMAL'])).toMatchObject({ normal: 'NORMAL', abnormal: '' });
    expect(suggestLabelValues(['0.0'])).toMatchObject({ normal: '', abnormal: '' });
  });

  it('anomaly의 0만 읽으면 1을 관례상 제안하되 관측된 값으로 설명하지 않는다', () => {
    const suggestion = suggestLabelValues(['0.0'], false, 'anomaly');

    expect(suggestion).toMatchObject({ normal: '0.0', abnormal: '1.0' });
    expect(suggestion.explanation).toContain('아직 관측하지 못했어요');
  });

  it('10,000행 뒤 값은 관측했다고 하지 않고 일부 읽기임을 표시한다', () => {
    const preview = inspectCsvText(
      'timestamp,label\n' + '2020-01-01,NORMAL\n'.repeat(10_001) + '2020-01-02,ABNORMAL\n',
    );

    expect(preview.partial).toBe(true);
    expect(preview.rowCount).toBe(10_000);
    expect(preview.values.label).toEqual(['NORMAL']);
  });

  it('취소된 파일을 읽지 않는다', async () => {
    const controller = new AbortController();

    controller.abort();
    await expect(
      inspectCsvFile(new File(['timestamp,label\n'], 'sample.csv'), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
