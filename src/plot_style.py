"""matplotlib 그림 설정 모음.

두 가지 역할을 한 파일에 둡니다.

1. `use_portable_style()` / `save_png()` — 운영체제(Windows·macOS·Linux)가 달라도 같은 그림 파일이
   나오도록 글꼴을 matplotlib 내장 DejaVu Sans로 고정하고 PNG의 버전 기록을 뺍니다. 영문 라벨을 쓰는
   01~05 노트북이 사용합니다.
2. `use_korean_font()` — 한글 라벨을 쓰는 08~10 노트북용. OS마다 설치된 한글 글꼴이 다르므로 후보를
   순서대로 찾아 첫 번째로 설치된 글꼴을 씁니다. 한글 글꼴은 OS마다 달라 그림 파일이 OS별로 다를 수
   있습니다.

같은 그림인데 git에서 '수정됨'으로 보이던 원인은 두 가지입니다.
1. matplotlib이 PNG마다 'Software: Matplotlib version 3.x.y'를 기록해 버전이 다르면 파일이 달라집니다.
2. 글꼴을 지정하지 않으면 OS에 설치된 글꼴 목록에 따라 다른 글꼴이 선택될 수 있습니다.
"""

from pathlib import Path
import warnings

import matplotlib as mpl
from matplotlib import font_manager


# PNG에 버전 기록을 남기지 않습니다. 픽셀은 그대로입니다.
PNG_METADATA = {"Software": None}
# matplotlib 설치본에 들어 있는 글꼴이라 모든 OS에서 같은 파일을 사용합니다.
FONT_FAMILY = "DejaVu Sans"

KOREAN_FONT_CANDIDATES = (
    "Malgun Gothic",      # Windows
    "AppleGothic",        # macOS
    "NanumGothic",        # Linux (fonts-nanum)
    "NanumBarunGothic",
    "Noto Sans CJK KR",
    "Noto Sans KR",
)


def use_portable_style():
    """글꼴을 고정하고, 노트북 화면에 표시되는 그림에서도 버전 기록을 뺍니다."""
    mpl.rcParams["font.family"] = FONT_FAMILY
    # SVG로 저장할 때 내부 ID가 실행마다 바뀌지 않게 합니다.
    mpl.rcParams["svg.hashsalt"] = "kkobugi"

    bundled_dir = Path(mpl.get_data_path(), "fonts", "ttf")
    for weight in ("normal", "bold"):
        properties = font_manager.FontProperties(family=FONT_FAMILY, weight=weight)
        found = Path(font_manager.findfont(properties, fallback_to_default=False))
        if found.parent != bundled_dir:
            warnings.warn(f"matplotlib 기본 글꼴 대신 {found}를 사용합니다. 그림이 OS마다 다를 수 있습니다.")

    _strip_inline_metadata()


def save_png(fig, path, **kwargs):
    """버전 기록 없이 PNG를 저장합니다. 나머지 인자는 Figure.savefig와 같습니다."""
    fig.savefig(path, format="png", metadata=PNG_METADATA, **kwargs)


def use_korean_font(candidates=KOREAN_FONT_CANDIDATES):
    """설치된 첫 번째 한글 글꼴을 matplotlib 기본 글꼴로 지정하고 그 이름을 돌려줍니다.

    글꼴이 하나도 없으면 영문 기본 글꼴을 그대로 두고 경고만 출력합니다(한글이 네모로 보입니다).
    """
    installed = {font.name for font in font_manager.fontManager.ttflist}
    chosen = next((name for name in candidates if name in installed), None)
    if chosen is None:
        warnings.warn("한글 글꼴을 찾지 못했습니다. 그래프의 한글이 깨져 보일 수 있습니다.")
    else:
        mpl.rcParams["font.family"] = chosen
    # 한글 글꼴에는 유니코드 마이너스(−) 글리프가 없는 경우가 있어 일반 하이픈을 씁니다.
    mpl.rcParams["axes.unicode_minus"] = False
    return chosen


def _strip_inline_metadata():
    # Jupyter가 아닐 때(터미널 실행 등)는 설정할 것이 없습니다.
    try:
        from IPython import get_ipython
        from matplotlib_inline.backend_inline import set_matplotlib_formats
        from matplotlib_inline.config import InlineBackend
    except ImportError:
        return
    if get_ipython() is None:
        return
    # 백엔드가 다시 초기화돼도 유지되도록 기본 저장 옵션 자체에 넣습니다.
    config = InlineBackend.instance()
    config.print_figure_kwargs = {**config.print_figure_kwargs, "metadata": PNG_METADATA}
    set_matplotlib_formats(*config.figure_formats)
