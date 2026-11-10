/** 관람 계정의 실제 메뉴를 안내한다. 단계 이동은 데이터를 변경하거나 작업을 실행하지 않는다. */
export const GUIDE_SECTIONS: {
  path: string;
  label: string;
  steps: { target: string; title: string; body: string }[];
}[] = [
  {
    path: '/',
    label: '작업실',
    steps: [
      {
        target: '[data-tour="dashboard-stats"]',
        title: '포부기와 작업 흐름 살펴보기',
        body: '데이터 등록부터 학습·검토까지 진행 상황을 모아 봐요. 관람 계정에서는 공개 예시를 사용하며 팀의 데이터나 기록을 바꾸지 않아요.',
      },
      {
        target: '[data-tour="dashboard-data"]',
        title: '어떤 데이터를 보고 있나요?',
        body: '현재 데이터의 이름과 검사 상태를 확인해요. 이후 데이터 → 모델 학습 → 시뮬레이션 → 구간 검토 순서로 둘러볼게요.',
      },
      {
        target: '[data-tour="expertise"]',
        title: '내게 편한 설명 선택',
        body: 'Pro는 쉬운 설명과 요약 점수, Pro+는 전문 용어와 상세 지표를 보여줘요. 표시 방식만 바뀌며 모델 결과나 계정 권한은 같아요.',
      },
    ],
  },
  {
    path: '/data',
    label: '데이터',
    steps: [
      {
        target: '[data-tour="data-files"]',
        title: '분석할 CSV 선택',
        body: '등록한 CSV를 고르면 해당 파일의 검사 결과로 바뀌어요. 관람 화면에서는 준비된 예시 CSV를 확인할 수 있어요.',
      },
      {
        target: '[data-tour="data-detail"]',
        title: '학습 전에 데이터 확인',
        body: '기간·결측값·정상과 이상 라벨의 분포를 먼저 확인해요. 포부기에게 현재 선택한 데이터의 검사 내용을 물어볼 수 있어요.',
      },
      {
        target: '[data-tour="data-upload"]',
        title: 'CSV 등록은 이렇게 진행돼요',
        body: '회원은 전처리된 CSV를 올리고 자동으로 찾은 시간열·라벨열과 정상·이상 값을 확인해요. 관람 계정은 파일을 서버에 등록하지 않아요.',
      },
    ],
  },
  {
    path: '/models',
    label: '모델 학습 선택',
    steps: [
      {
        target: '[data-tour="training-dataset"]',
        title: '학습 데이터 연결',
        body: '검사가 끝난 데이터셋을 골라요. 관람 계정은 설정과 예시 결과를 살펴보며 실제 학습 작업은 실행하지 않아요.',
      },
      {
        target: '[data-tour="training-model"]',
        title: '학습할 모델 하나 선택',
        body: 'XGBoost는 정상·이상 사례를 배우고, AutoEncoder는 정상 패턴에서 벗어나는 정도를 확인해요. 한 번에 선택한 모델 하나를 학습하는 흐름이에요.',
      },
      {
        target: '[data-tour="training-split"]',
        title: '시간순으로 나누고 확인',
        body: '앞부분으로 학습하고 뒷부분을 중간·최종 확인에 사용하며 자동 설정을 조정할 수 있어요. 평가 구간에 이상이 없다면 정상 정답률과 이상 탐지 성능을 구분해서 봐요.',
      },
    ],
  },
  {
    path: '/simulation',
    label: '시뮬레이션',
    steps: [
      {
        target: '[data-tour="simulation-toolbar"]',
        title: '재생과 화면을 직접 조절',
        body: '재생 설정·부품·그래프를 열거나 접을 수 있어요. 관람 계정도 준비된 예시를 재생·일시 정지하고 속도를 바꿔볼 수 있어요.',
      },
      {
        target: '[data-tour="simulation-workspace"] .pump-simulation-main',
        title: '펌프와 이상 표시 확인',
        body: '예시 값이 흘러가며 이상 구간에서 펌프가 붉게 표시돼요. 관람 화면은 실제 학습 모델의 추론이 아니며 붉은 표시는 고장 확정이나 특정 부품 진단이 아니에요.',
      },
      {
        target: '[data-tour="simulation-status"]',
        title: '현재 시점과 근거 확인',
        body: '현재 재생 위치와 알림을 확인하고 그래프를 함께 살펴보세요. 부품의 점검 안내에서 포부기에게 근거와 추가 확인 사항을 물어볼 수 있어요.',
      },
    ],
  },
  {
    path: '/review',
    label: '시뮬레이션 보고서',
    steps: [
      {
        target: '[data-tour="review-source"]',
        title: '같은 데이터·채널로 확인',
        body: '데이터와 센서 채널을 고르고 모델 예측을 원본 라벨과 구분해 확인해요. 관람 화면의 값과 그래프는 공개 예시예요.',
      },
      {
        target: '[data-tour="review-chart"]',
        title: '이상이 발생한 구간 살펴보기',
        body: '시간축에서 관심 구간을 선택해 앞뒤 흐름을 살펴보세요. 이상 예측은 현장 점검을 위한 단서이며 고장 원인을 확정하지 않아요.',
      },
      {
        target: '[data-tour="review-observations"]',
        title: '직접 본 내용은 별도로 기록',
        body: '현장 관찰과 모델의 판단을 구분해 검토해요. 관람 중 작성하는 초안은 브라우저의 예시용이며 팀의 점검·검토 기록에 저장되지 않아요.',
      },
    ],
  },
  {
    path: '/reports',
    label: '보고서',
    steps: [
      {
        target: '[data-tour="reports-page"] > .page-header',
        title: '검토 근거를 한곳에 모으기',
        body: '데이터·모델 결과·현장 관찰을 구분한 문서와 포부기가 작성한 보고서를 확인하는 곳이에요. 관람 계정에서는 공개 예시를 살펴보며 팀 보고서를 수정하지 않아요.',
      },
      {
        target: '[data-tour="reports-export"]',
        title: '문서 확인 후 내보내기',
        body: '검토 기록은 내용을 확인한 뒤 인쇄·PDF로 남길 수 있어요. 생성된 AI 보고서도 출처와 입력 조건을 확인하며, 안내 과정에서 다운로드나 저장을 자동 실행하지 않아요.',
      },
    ],
  },
  {
    path: '/costs',
    label: '비용 비교',
    steps: [
      {
        target: '[data-tour="costs-period"]',
        title: '같은 기간으로 비용 비교',
        body: '모델 결과와 현장 관찰을 먼저 검토하고 두 대응안의 비교 기간을 정해요. 모델만으로 교체 부품이나 남은 수명을 확정하지 않아요.',
      },
      {
        target: '[data-tour="costs-inputs"]',
        title: '견적과 작업 조건은 직접 입력',
        body: '점검비·부품비·작업비와 정지 손실을 알고 있는 근거로 입력해요. AI가 실제 부품 가격이나 교체 필요성을 자동으로 만들어내지 않아요.',
      },
      {
        target: '[data-tour="costs-result"]',
        title: '입력한 가정에 따른 차이',
        body: '입력 조건의 합계와 차이를 비교할 수 있으며 실제 절감액을 예측한 값은 아니에요. 이 화면의 계산 입력은 저장되지 않아요.',
      },
    ],
  },
];
