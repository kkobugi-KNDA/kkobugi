"""Jupyter 노트북의 출력과 내용은 유지하고 실행 번호와 셀 실행 시각 기록을 비웁니다.

출력 그림이 마지막 커밋(HEAD)의 같은 셀 그림과 픽셀까지 같으면 커밋된 PNG 데이터를 그대로 둡니다.
Pillow·zlib 버전이 다르면 같은 그림도 압축 결과가 달라져 git에서 '수정됨'으로 보이기 때문입니다.
"""

import argparse
import base64
import binascii
import io
import json
from pathlib import Path
import subprocess
from tempfile import NamedTemporaryFile


EXCLUDE_DIRS = {".git", ".ipynb_checkpoints", ".venv", "venv"}


def clear_execution_count(file_path: Path) -> bool:
    """코드 셀과 결과의 실행 번호를 지우고, 파일이 바뀌었는지 반환합니다."""
    file_path = Path(file_path)
    with file_path.open(encoding="utf-8", newline="") as source:
        original = source.read()
    notebook = json.loads(original)
    if notebook.get("nbformat") != 4:
        raise ValueError("Jupyter 노트북 형식 버전 4가 필요합니다.")

    changed = False
    for cell in notebook["cells"]:
        if cell["cell_type"] != "code":
            continue
        # 실행 번호가 저장되는 실제 JSON 항목만 수정합니다.
        for item in (cell, *cell["outputs"]):
            if item.get("execution_count") is not None:
                item["execution_count"] = None
                changed = True
        # nbconvert·JupyterLab이 남기는 셀 실행 시각은 실행할 때마다 달라지므로 지웁니다.
        if cell.get("metadata", {}).pop("execution", None) is not None:
            changed = True
    changed = keep_committed_images(notebook, file_path) or changed
    if not changed:
        return False

    newline = "\r\n" if "\r\n" in original else "\n"
    updated = json.dumps(notebook, ensure_ascii=False, indent=1)
    if original.endswith("\n"):
        updated += "\n"

    # 저장이 중단돼도 원본이 잘리지 않도록 같은 폴더에서 임시 저장 후 교체합니다.
    temp_path = None
    try:
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", newline=newline, dir=file_path.parent, delete=False
        ) as temporary:
            temp_path = Path(temporary.name)
            temporary.write(updated)
        temp_path.replace(file_path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    return True


def keep_committed_images(notebook, file_path: Path) -> bool:
    """HEAD의 같은 셀(셀 id 기준) 그림과 픽셀이 같은 출력 그림을 커밋된 데이터로 되돌립니다."""
    committed = _committed_notebook(file_path)
    if committed is None:
        return False
    old_images = {
        cell["id"]: [output["data"]["image/png"] for output in cell.get("outputs", [])
                     if "image/png" in output.get("data", {})]
        for cell in committed.get("cells", []) if "id" in cell
    }
    changed = False
    for cell in notebook["cells"]:
        olds = old_images.get(cell.get("id"), [])
        news = [output["data"] for output in cell.get("outputs", []) if "image/png" in output.get("data", {})]
        # 셀 안의 그림 순서대로 짝을 짓습니다. 그림 수가 다르면 셀 결과가 바뀐 것이므로 건드리지 않습니다.
        if len(olds) != len(news):
            continue
        for old, data in zip(olds, news):
            if data["image/png"] != old and _same_pixels(old, data["image/png"]):
                data["image/png"] = old
                changed = True
    return changed


def _committed_notebook(file_path: Path):
    # git 저장소가 아니거나 아직 커밋되지 않은 노트북이면 비교하지 않습니다.
    try:
        result = subprocess.run(
            ["git", "show", f"HEAD:./{file_path.name}"],
            cwd=file_path.resolve().parent, capture_output=True, check=True,
        )
        return json.loads(result.stdout.decode("utf-8"))
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _same_pixels(first, second) -> bool:
    try:
        from PIL import Image  # matplotlib을 설치하면 함께 설치됩니다.
    except ImportError:
        return False
    try:
        images = [Image.open(io.BytesIO(base64.b64decode("".join(data)))) for data in (first, second)]
        keys = [(image.size, image.mode, image.info.get("dpi")) for image in images]
        return keys[0] == keys[1] and images[0].tobytes() == images[1].tobytes()
    except (OSError, ValueError, binascii.Error):
        return False


def find_notebooks(root: Path):
    """가상 환경과 체크포인트 폴더를 제외하고 노트북을 찾습니다."""
    for file_path in sorted(root.rglob("*.ipynb")):
        if EXCLUDE_DIRS.isdisjoint(file_path.relative_to(root).parts) and file_path.is_file():
            yield file_path


def main():
    # 경로를 생략하면 현재 작업 위치와 관계없이 저장소의 notebooks/를 사용합니다.
    default_target = Path(__file__).resolve().parents[1] / "notebooks"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", type=Path, default=default_target,
                        help="노트북 파일 또는 폴더 경로")
    target = parser.parse_args().target
    if target.is_dir():
        files = list(find_notebooks(target))
    elif target.is_file() and target.suffix.lower() == ".ipynb":
        files = [target]
    else:
        parser.error(f"노트북 파일이나 폴더를 지정해주세요. 입력 경로: {target}")

    changed_count = 0
    error_count = 0
    for file_path in files:
        try:
            changed = clear_execution_count(file_path)
            print(f"{'정리함' if changed else '변경 없음'}: {file_path}")
            changed_count += changed
        except (OSError, ValueError, KeyError) as error:
            print(f"처리 실패: {file_path} — {error}")
            error_count += 1

    print(f"총 {len(files)}개 | 변경 {changed_count}개 | 오류 {error_count}개")
    return 1 if error_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
