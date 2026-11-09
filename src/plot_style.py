"""matplotlib 한글 표시 설정.

운영체제마다 설치된 한글 글꼴이 다르므로 후보를 순서대로 찾아 첫 번째로 설치된 글꼴을 씁니다.
글꼴이 하나도 없으면 영문 기본 글꼴을 그대로 두고 경고만 출력합니다(한글이 네모로 보입니다).
"""

import warnings

from matplotlib import font_manager, rcParams

KOREAN_FONT_CANDIDATES = (
    "Malgun Gothic",      # Windows
    "AppleGothic",        # macOS
    "NanumGothic",        # Linux (fonts-nanum)
    "NanumBarunGothic",
    "Noto Sans CJK KR",
    "Noto Sans KR",
)


def use_korean_font(candidates=KOREAN_FONT_CANDIDATES):
    """설치된 첫 번째 한글 글꼴을 matplotlib 기본 글꼴로 지정하고 그 이름을 돌려줍니다."""
    installed = {font.name for font in font_manager.fontManager.ttflist}
    chosen = next((name for name in candidates if name in installed), None)
    if chosen is None:
        warnings.warn("한글 글꼴을 찾지 못했습니다. 그래프의 한글이 깨져 보일 수 있습니다.")
    else:
        rcParams["font.family"] = chosen
    # 한글 글꼴에는 유니코드 마이너스(−) 글리프가 없는 경우가 있어 일반 하이픈을 씁니다.
    rcParams["axes.unicode_minus"] = False
    return chosen
