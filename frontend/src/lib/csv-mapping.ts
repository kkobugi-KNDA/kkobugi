import Papa from 'papaparse';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const MAX_PREVIEW_ROWS = 10_000;

const MAX_LABEL_VALUES = 32;

export interface CsvMappingPreview {
  columns: string[];
  timestampCandidates: string[];
  labelCandidates: string[];
  timestampColumn: string;
  labelColumn: string;
  values: Record<string, string[]>;
  truncatedValues: string[];
  rowCount: number;
  partial: boolean;
  delimiter: string;
}

export interface LabelSuggestion {
  normal: string;
  abnormal: string;
  explanation: string;
}

/** 문자열을 그대로 보존한다. 숫자 변환은 후보 판별에만 쓰고 CSV를 수정하지 않는다. */
export function suggestLabelValues(
  values: string[],
  truncated = false,
  column = '',
): LabelSuggestion {
  if (truncated)
    return {
      normal: '',
      abnormal: '',
      explanation: '값의 종류가 많아 자동 지정하지 않았어요. 올바른 판정 열인지 확인해주세요.',
    };

  const normalWords = values.filter((value) => /^(normal|healthy|정상)$/i.test(value));

  const abnormalWords = values.filter((value) =>
    /^(abnormal|unnormal|anomaly|faulty|fault|broken|이상|비정상)$/i.test(value),
  );

  const zeros = values.filter((value) => /^0(?:\.0+)?$/.test(value));

  const ones = values.filter((value) => /^1(?:\.0+)?$/.test(value));

  if (
    values.length === 1 &&
    zeros.length === 1 &&
    /^(anomaly|isanomaly|isabnormal)$/i.test(column.replace(/[_\s-]/g, ''))
  ) {
    const proposedAbnormal = zeros[0].replace(/^0/, '1');

    return {
      normal: zeros[0],
      abnormal: proposedAbnormal,
      explanation: `읽은 범위에는 ${zeros[0]}만 있어요. anomaly의 0=정상·1=이상 관례로 ${proposedAbnormal}을 제안했지만, 이 값은 아직 관측하지 못했어요. 원본 라벨 정의를 확인해주세요.`,
    };
  }
  if (values.length === 2 && zeros.length === 1 && ones.length === 1) {
    return {
      normal: zeros[0],
      abnormal: ones[0],
      explanation:
        '0은 정상, 1은 이상으로 쓰는 관례에 따라 제안했어요. 이 파일의 라벨 정의와 같은지 확인해주세요. 소수점 표기는 원본 그대로예요.',
    };
  }
  if (values.length === 2 && normalWords.length === 1 && abnormalWords.length === 1) {
    return {
      normal: normalWords[0],
      abnormal: abnormalWords[0],
      explanation:
        '원본에서 정상·이상을 뜻하는 두 값을 확인했어요. 대소문자를 바꾸지 않고 채웠어요.',
    };
  }
  return {
    normal: normalWords.length === 1 ? normalWords[0] : '',
    abnormal: values.length === 1 && abnormalWords.length === 1 ? abnormalWords[0] : '',
    explanation:
      values.length === 1
        ? '읽은 범위에 한 종류의 값만 있어요. 확인하지 못한 반대쪽 값은 원본을 확인해 직접 지정해주세요.'
        : values.length > 2
          ? '세 종류 이상의 값이 있어요. 여러 고장 상태를 하나로 사용할지는 전처리에서 정하고, 정상·이상 두 값을 지정해주세요.'
          : '값의 의미를 확정할 수 없어 자동 지정하지 않았어요. 빈도만으로 정상·이상을 결정하지 않아요.',
  };
}

export function inspectCsvText(source: string, byteLimited = false): CsvMappingPreview {
  // 큰 파일의 마지막 불완전한 행은 미리보기에서 제외한다.
  const text = (byteLimited ? source.slice(0, source.lastIndexOf('\n') + 1) : source).replace(
    /^\uFEFF/,
    '',
  );

  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    preview: MAX_PREVIEW_ROWS + 2,
  });

  const columns = parsed.data[0] || [];

  if (
    parsed.errors.some((error) => error.type === 'Quotes') ||
    columns.length < 2 ||
    new Set(columns).size !== columns.length
  ) {
    throw new Error(
      'CSV의 구분자·따옴표·중복 열 이름을 확인해주세요. 자동 채우기 없이 직접 지정할 수 있어요.',
    );
  }
  const rows = parsed.data.slice(1, MAX_PREVIEW_ROWS + 1);

  // 임의의 열 이름도 객체의 기본 속성과 충돌하지 않게 저장한다.
  const values = Object.create(null) as Record<string, string[]>;

  for (const column of columns) values[column] = [];

  const truncatedValues = new Set<string>();

  for (const row of rows) {
    columns.forEach((column, index) => {
      const value = row[index] ?? '';

      if (!value || values[column].includes(value)) return;
      if (value.length > 128) {
        truncatedValues.add(column);
        return;
      }
      if (values[column].length === MAX_LABEL_VALUES) truncatedValues.add(column);
      else values[column].push(value);
    });
  }
  const timestampCandidates = columns.filter((column) =>
    /^(timestamp|datetime|date|time|measuredat|측정시각|측정시간)$/i.test(
      column.replace(/[\s_-]/g, ''),
    ),
  );

  const labelCandidates = columns.filter(
    (column) =>
      /(?:^|[_\s-])(label|status|anomaly|target|class)$/i.test(column) ||
      /^(machinestatus|라벨|판정|상태)$/i.test(column.replace(/[\s_-]/g, '')),
  );

  // 전처리된 정답 열이 하나면 원래의 다중 상태 열(machine_status)보다 우선한다.
  const explicitLabelCandidates = labelCandidates.filter((column) =>
    /^(label|anomaly|target)$/i.test(column),
  );

  const preferredLabelCandidates = explicitLabelCandidates.length
    ? explicitLabelCandidates
    : labelCandidates;

  return {
    columns,
    timestampCandidates,
    labelCandidates,
    timestampColumn: timestampCandidates.length === 1 ? timestampCandidates[0] : '',
    labelColumn: preferredLabelCandidates.length === 1 ? preferredLabelCandidates[0] : '',
    values,
    truncatedValues: [...truncatedValues],
    rowCount: rows.length,
    partial: byteLimited || parsed.data.length > MAX_PREVIEW_ROWS + 1 || parsed.meta.truncated,
    delimiter: parsed.meta.delimiter,
  };
}

/** 최대 2 MiB만 읽어 큰 파일도 화면을 오래 막지 않는다. 최종 검사는 서버가 전체에 수행한다. */
export function inspectCsvFile(file: File, signal: AbortSignal): Promise<CsvMappingPreview> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    const cancel = () => {
      reader.abort();
      reject(new DOMException('취소됨', 'AbortError'));
    };

    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    reader.onload = () => {
      signal.removeEventListener('abort', cancel);
      try {
        resolve(inspectCsvText(String(reader.result), file.size > MAX_PREVIEW_BYTES));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => {
      signal.removeEventListener('abort', cancel);
      reject(new Error('파일 미리보기를 읽지 못했어요. 열 이름과 라벨 값을 직접 지정해주세요.'));
    };
    reader.readAsText(file.slice(0, MAX_PREVIEW_BYTES), 'UTF-8');
  });
}
