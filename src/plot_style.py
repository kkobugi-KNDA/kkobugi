"""matplotlib 그림 설정 모음.

두 가지 역할을 한 파일에 둡니다.

1. `use_portable_style()` / `save_png()` — 운영체제(Windows·macOS·Linux)가 달라도 같은 그림 파일이
   나오도록 글꼴을 matplotlib 내장 DejaVu Sans로 고정하고 PNG의 버전 기록을 뺍니다. 영문 라벨을 쓰는
   01~05 노트북이 사용합니다.
   06·07 노트북도 같은 방식을 씁니다.
2. `use_korean_font()` — 한글 라벨을 쓰는 08~10 노트북용. 저장소 `fonts/`에 넣은 나눔고딕(OFL 라이선스)만
   사용합니다. PC에 설치된 한글 글꼴(맑은 고딕, AppleGothic 등)은 쓰지 않으므로 OS와 관계없이 같은
   그림이 나옵니다. 영문·숫자·기호는 DejaVu Sans, 한글은 나눔고딕으로 그립니다.

`save_png()`는 기존 파일과 픽셀이 같으면 파일을 덮어쓰지 않습니다. Pillow·zlib 버전에 따라 같은 그림도
압축 결과(파일 바이트)가 달라져 git에서 '수정됨'으로 보이기 때문입니다.

같은 그림인데 git에서 '수정됨'으로 보이던 원인은 두 가지입니다.
1. matplotlib이 PNG마다 'Software: Matplotlib version 3.x.y'를 기록해 버전이 다르면 파일이 달라집니다.
2. 글꼴을 지정하지 않으면 OS에 설치된 글꼴 목록에 따라 다른 글꼴이 선택될 수 있습니다.
"""

from pathlib import Path
import io
import warnings

import matplotlib as mpl
from matplotlib import font_manager


# PNG에 버전 기록을 남기지 않습니다. 픽셀은 그대로입니다.
PNG_METADATA = {"Software": None}
# matplotlib 설치본에 들어 있는 글꼴이라 모든 OS에서 같은 파일을 사용합니다.
FONT_FAMILY = "DejaVu Sans"

# 저장소에 포함한 한글 글꼴입니다. 라이선스는 fonts/OFL.txt를 참고하세요.
KOREAN_FONT_DIR = Path(__file__).resolve().parents[1] / "fonts"
KOREAN_FONT_FILES = ("NanumGothic-Regular.ttf", "NanumGothic-Bold.ttf")
KOREAN_FONT = "NanumGothic"


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
    """버전 기록 없이 PNG를 저장하고, 실제로 파일을 썼으면 True를 돌려줍니다.

    기존 파일과 크기·해상도·픽셀이 모두 같으면 파일을 그대로 둡니다. 나머지 인자는 Figure.savefig와 같습니다.
    """
    path = Path(path)
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", metadata=PNG_METADATA, **kwargs)
    data = buffer.getvalue()
    if path.is_file() and same_png(path.read_bytes(), data):
        return False
    path.write_bytes(data)
    return True


def same_png(first, second):
    """두 PNG 데이터의 크기·색 형식·해상도·픽셀이 모두 같은지 확인합니다. 압축 방식 차이는 무시합니다."""
    if first == second:
        return True
    from PIL import Image  # matplotlib 설치 시 함께 설치됩니다.

    try:
        images = [Image.open(io.BytesIO(data)) for data in (first, second)]
        keys = [(image.size, image.mode, image.info.get("dpi")) for image in images]
        return keys[0] == keys[1] and images[0].tobytes() == images[1].tobytes()
    except OSError:
        return False


def use_korean_font():
    """저장소의 나눔고딕을 기본 글꼴로 지정하고, 화면 그림의 버전 기록도 뺀 뒤 글꼴 이름을 돌려줍니다."""
    font_dir = KOREAN_FONT_DIR.resolve()
    manager = font_manager.fontManager
    # PC에 같은 이름의 나눔고딕이 설치돼 있어도 버전이 다를 수 있으므로 저장소 파일만 남깁니다.
    manager.ttflist = [
        entry for entry in manager.ttflist
        if entry.name != KOREAN_FONT or Path(entry.fname).resolve().parent == font_dir
    ]
    registered = {Path(entry.fname).resolve() for entry in manager.ttflist}
    for filename in KOREAN_FONT_FILES:
        path = font_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"{path}가 없습니다. 저장소의 fonts/ 폴더를 확인하세요.")
        if path not in registered:
            manager.addfont(str(path))
    # 글꼴 목록을 바꿨으므로 이전에 찾아 둔 결과를 비웁니다.
    manager._findfont_cached.cache_clear()

    # 영문·숫자·기호는 matplotlib 내장 DejaVu Sans, 그 글꼴에 없는 한글은 나눔고딕으로 그립니다.
    # 로그 눈금(10⁻¹)처럼 수식으로 그리는 글자는 첫 번째 글꼴만 쓰는데, 나눔고딕에는 마이너스(−)가 없습니다.
    mpl.rcParams["font.family"] = [FONT_FAMILY, KOREAN_FONT]
    mpl.rcParams["axes.unicode_minus"] = False
    mpl.rcParams["svg.hashsalt"] = "kkobugi"
    for weight in ("normal", "bold"):
        properties = font_manager.FontProperties(family=KOREAN_FONT, weight=weight)
        found = Path(font_manager.findfont(properties, fallback_to_default=False)).resolve()
        if found.parent != font_dir:
            warnings.warn(f"저장소 글꼴 대신 {found}를 사용합니다. 그림이 OS마다 다를 수 있습니다.")

    _strip_inline_metadata()
    return KOREAN_FONT


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
