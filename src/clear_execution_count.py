"""Jupyter 노트북의 출력과 내용은 유지하고 실행 번호만 비웁니다."""

import argparse
import json
from pathlib import Path
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
            print(f"{'실행 번호 초기화' if changed else '변경 없음'}: {file_path}")
            changed_count += changed
        except (OSError, ValueError, KeyError) as error:
            print(f"처리 실패: {file_path} — {error}")
            error_count += 1

    print(f"총 {len(files)}개 | 변경 {changed_count}개 | 오류 {error_count}개")
    return 1 if error_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
