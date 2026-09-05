"""
検索式の実績を集計して docs/search-queries.md を生成する。

    python3 scripts/rank.py          生成する
    python3 scripts/rank.py --check  生成せず、中身の検査だけする（CI用）

なぜ作ったか：
ある案件のソーシングで、効いた検索式と空振りした検索式が5つのファイルに散らばっていた。
「読むファイルによって結論が違う」状態だったので、CSVを正本にして、
そこから1枚を生成する形にした。

このファイルは個人情報を扱わない。検索式と件数だけを持つ。
候補者の氏名・経歴・連絡先は、たとえコメントであっても書かないこと。
"""

import csv
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "queries.csv"
OUT = ROOT / "docs" / "queries.md"

VERDICTS = ("効いた", "空振り", "未着手")

# LinkedInは3語までが上限。4語以上重ねると数件しか出ず死ぬ（2026-08-25 実測）
LINKEDIN_WORD_LIMIT = 3


def word_count(query):
    """検索語の数を数える。GitHubの `location:Japan` のような修飾子も1語として数える"""
    q = query.strip()
    if not q:
        return 0
    # 括弧とOR/ANDは語として数えない
    q = re.sub(r"[()]", " ", q)
    words = [w for w in q.split() if w.upper() not in ("OR", "AND")]
    return len(words)


def load():
    with SRC.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def check(rows):
    """CSVの中身を検査する。問題があればメッセージのリストを返す"""
    problems = []
    seen = set()
    for i, r in enumerate(rows, start=2):
        rid = (r.get("id") or "").strip()
        if not rid:
            problems.append("{}行目：id が空です".format(i))
        elif rid in seen:
            problems.append("{}行目：id が重複しています（{}）".format(i, rid))
        else:
            seen.add(rid)

        if not (r.get("query") or "").strip():
            problems.append("{}行目：query が空です".format(i))

        v = (r.get("verdict") or "").strip()
        if v not in VERDICTS:
            problems.append(
                "{}行目：verdict は {} のいずれかにしてください（いまは「{}」）".format(
                    i, " / ".join(VERDICTS), v))

        # 判定が付いているのに、なぜそうなったかが書かれていない
        if v in ("効いた", "空振り") and not (r.get("why") or "").strip():
            problems.append("{}行目：why が空です。判定の理由は必ず残してください".format(i))

        # 空振りなのに理由が「未着手」のまま、のような取り違え
        if v == "未着手" and (r.get("found_good") or "").strip():
            problems.append("{}行目：未着手なのに found_good が入っています".format(i))
    return problems


def to_int(s):
    s = (s or "").strip()
    try:
        return int(s)
    except ValueError:
        return None


def render(rows):
    lines = []
    lines.append("# 検索式ライブラリ（自動生成）")
    lines.append("")
    lines.append("**このファイルは編集しないでください。**")
    lines.append("正本は `data/queries.csv` です。")
    lines.append("`python3 scripts/rank.py` で再生成されます。")
    lines.append("")

    hit = [r for r in rows if r["verdict"] == "効いた"]
    miss = [r for r in rows if r["verdict"] == "空振り"]
    todo = [r for r in rows if r["verdict"] == "未着手"]

    def good(r):
        n = to_int(r.get("found_good"))
        return n if n is not None else -1

    hit.sort(key=good, reverse=True)

    lines.append("## サマリ")
    lines.append("")
    lines.append("| | 本数 |")
    lines.append("|---|---|")
    lines.append("| 効いた | {} |".format(len(hit)))
    lines.append("| 空振り | {} |".format(len(miss)))
    lines.append("| 未着手 | {} |".format(len(todo)))
    lines.append("")

    # 語数と結果の関係。LinkedInの3語ルールが本当かを、毎回データで確かめる
    li = [r for r in rows if r["media"] == "LinkedIn" and r["verdict"] in ("効いた", "空振り")]
    if li:
        lines.append("### 語数と結果（LinkedIn）")
        lines.append("")
        lines.append("| 語数 | 効いた | 空振り |")
        lines.append("|---|---|---|")
        by_w = {}
        for r in li:
            w = word_count(r["query"])
            by_w.setdefault(w, {"効いた": 0, "空振り": 0})
            by_w[w][r["verdict"]] += 1
        for w in sorted(by_w):
            mark = " ←上限" if w == LINKEDIN_WORD_LIMIT else ""
            lines.append("| {}語{} | {} | {} |".format(
                w, mark, by_w[w]["効いた"], by_w[w]["空振り"]))
        lines.append("")
        over = [r for r in li if word_count(r["query"]) > LINKEDIN_WORD_LIMIT]
        if over:
            n_miss = len([r for r in over if r["verdict"] == "空振り"])
            lines.append("> {}語を超える検索式は{}本あり、うち{}本が空振りでした。".format(
                LINKEDIN_WORD_LIMIT, len(over), n_miss))
            lines.append("")

    def table(title, items, show_good):
        lines.append("## {}".format(title))
        lines.append("")
        if not items:
            lines.append("（なし）")
            lines.append("")
            return
        head = "| 媒体 | 検索式 | 語数 |"
        sep = "|---|---|---|"
        if show_good:
            head += " ◎の数 |"
            sep += "---|"
        head += " 理由 | 対象 | 試した日 |"
        sep += "---|---|---|"
        lines.append(head)
        lines.append(sep)
        for r in items:
            row = "| {} | `{}` | {} |".format(
                r["media"], r["query"], word_count(r["query"]))
            if show_good:
                row += " {} |".format(r.get("found_good") or "-")
            row += " {} | {} | {} |".format(
                (r.get("why") or "").replace("|", "／"),
                r.get("target_role") or "-",
                r.get("tried_at") or "-")
            lines.append(row)
        lines.append("")

    table("✅ 効いた", hit, True)
    table("❌ 空振り", miss, False)
    table("⬜ 未着手", todo, False)

    lines.append("---")
    lines.append("")
    lines.append("## 使い方")
    lines.append("")
    lines.append("1. 検索を試したら `data/queries.csv` に1行足す")
    lines.append("2. `verdict` は 効いた / 空振り / 未着手 のいずれか")
    lines.append("3. **`why` は必ず書く。**なぜ効いた／効かなかったかが、次の検索式を決める")
    lines.append("4. `found_good` には、その検索から◎判定に至った人数を入れる")
    lines.append("")
    lines.append("**件数が多いことは、効いたことを意味しません。**")
    lines.append("94件出ても◎が2人なら、それは絞り込みが甘いということです。")
    lines.append("")
    return "\n".join(lines) + "\n"


def main():
    if not SRC.exists():
        print("見つかりません：{}".format(SRC))
        return 1

    rows = load()
    problems = check(rows)

    print("検索式：{} 本".format(len(rows)))
    if problems:
        print("\n🚨 {} 件の問題が見つかりました。\n".format(len(problems)))
        for p in problems:
            print("  - {}".format(p))
        print("")
        return 1
    print("✅ CSVの中身に問題はありません。")

    if "--check" in sys.argv:
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(rows), encoding="utf-8")
    print("生成しました：{}".format(OUT.relative_to(ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
