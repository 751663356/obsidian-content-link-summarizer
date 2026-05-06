#!/usr/bin/env python3
import json
import sys

from rapidocr_onnxruntime import RapidOCR


def main() -> int:
    if len(sys.argv) < 2:
        print("", end="")
        return 0

    ocr = RapidOCR()
    lines = []
    for image_path in sys.argv[1:]:
        result, _ = ocr(image_path)
        if not result:
            continue
        for item in result:
            if len(item) >= 2 and item[1]:
                lines.append(str(item[1]))

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
