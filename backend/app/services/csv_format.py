"""원본을 수정하지 않고 첫 CSV 헤더에서 구분자를 확인한다."""

import csv
from typing import TextIO


def detect_csv_delimiter(stream: TextIO) -> str:
    """따옴표 안의 기호를 제외해 감지하고, 호출 전 파일 위치를 반드시 복원한다."""
    position = stream.tell()

    try:
        stream.seek(0)
        sample = stream.read(65_536)
    finally:
        stream.seek(position)
    counts = {",": 0, ";": 0, "\t": 0}

    quoted = False

    index = 0

    while index < len(sample):
        character = sample[index]

        if character == '"':
            if quoted and index + 1 < len(sample) and sample[index + 1] == '"':
                index += 2
                continue
            quoted = not quoted
        elif not quoted:
            if character in "\r\n":
                break
            if character in counts:
                counts[character] += 1
        index += 1
    if quoted or (index == len(sample) == 65_536):
        raise csv.Error("CSV 헤더가 너무 길거나 따옴표가 닫히지 않았습니다.")
    return max(counts, key=counts.get)
