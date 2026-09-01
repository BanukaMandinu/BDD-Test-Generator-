"""Builds TestGenerator-Handbook.pdf from SETUP.md + README.md.

A small, purpose-built Markdown renderer rather than a general one: it only needs
to handle the constructs these two files actually use (headings, paragraphs,
fenced code, tables, bullet/numbered lists, blockquotes, rules, and inline
bold/code/links). Anything it doesn't recognise falls through as plain text, so a
future edit to the docs can never crash the build.
"""

import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, KeepTogether, ListFlowable, ListItem,
    PageBreak, PageTemplate, Paragraph, Preformatted, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "TestGenerator-Handbook.pdf"

INK = colors.HexColor("#1f2430")
MUTED = colors.HexColor("#667085")
ACCENT = colors.HexColor("#2f5fed")
RULE = colors.HexColor("#dde1e6")
CODE_BG = colors.HexColor("#f4f6fa")
TABLE_HEAD = colors.HexColor("#eef1f7")

styles = getSampleStyleSheet()


def make_styles():
    # Written out in full rather than spread from a shared dict: ParagraphStyle
    # treats a repeated keyword as an error, not an override.
    def st(name, size, leading, **kw):
        kw.setdefault("fontName", "Helvetica")
        kw.setdefault("textColor", INK)
        kw.setdefault("alignment", TA_LEFT)
        return ParagraphStyle(name, fontSize=size, leading=leading, **kw)

    return {
        "title": st("t", 26, 31, fontName="Helvetica-Bold", spaceAfter=6),
        "subtitle": st("st", 11.5, 16, textColor=MUTED, spaceAfter=20),
        "h1": st("h1", 19, 24, fontName="Helvetica-Bold", spaceBefore=20,
                 spaceAfter=9, textColor=colors.HexColor("#16203a")),
        "h2": st("h2", 14.5, 19, fontName="Helvetica-Bold", spaceBefore=16, spaceAfter=7),
        "h3": st("h3", 12, 16, fontName="Helvetica-Bold", spaceBefore=13, spaceAfter=5),
        "h4": st("h4", 10.8, 15, fontName="Helvetica-Bold", spaceBefore=11, spaceAfter=4),
        "body": st("b", 9.8, 14.8, spaceAfter=7),
        "li": st("li", 9.8, 14.4, spaceAfter=3),
        "code": st("c", 8.4, 11.6, fontName="Courier",
                   textColor=colors.HexColor("#243044")),
        "quote": st("q", 9.4, 14, leftIndent=9,
                    textColor=colors.HexColor("#6b4a12")),
        "cell": st("cell", 8.8, 12.4),
        "cellhead": st("ch", 8.8, 12.4, fontName="Helvetica-Bold"),
        "footer": st("f", 8, 10, textColor=MUTED),
    }


S = make_styles()


# ReportLab's built-in Helvetica/Courier can only encode WinAnsi (cp1252).
# Anything outside it renders as a solid black box, so map the characters the docs
# actually use to safe equivalents. Applied to the whole file, code blocks
# included, so a future doc edit can't silently produce boxes.
GLYPH_FIXES = {
    "→": "->",    # →
    "↔": "<->",   # ↔
    "≈": "~",     # ≈
    "▾": "",      # ▾  (a UI dropdown caret; the label reads fine without it)
    "▸": ">",     # ▸
    "✓": "[yes]", # ✓
    "✗": "[no]",  # ✗
    "•": "-",     # •
    "×": "x",     # ×
}


def sanitize(md):
    for bad, good in GLYPH_FIXES.items():
        md = md.replace(bad, good)
    # Anything still unencodable would print as a box — drop it rather than ship
    # a corrupted-looking page, and say so on the console.
    out = []
    dropped = set()
    for ch in md:
        try:
            ch.encode("cp1252")
            out.append(ch)
        except UnicodeEncodeError:
            dropped.add(ch)
    if dropped:
        print("  note: dropped unrenderable characters:",
              " ".join(f"U+{ord(c):04X}" for c in sorted(dropped)))
    return "".join(out)


def inline(text):
    """Markdown inline -> ReportLab markup. Escapes first so tags can't inject."""
    t = html.escape(text, quote=False)

    # `code` — do this before bold/italic so underscores inside code survive.
    t = re.sub(r"`([^`]+)`",
               r'<font face="Courier" size="8.6" color="#243044">\1</font>', t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<i>\1</i>", t)
    # [label](target) -> label, optionally linked when it's a real URL.
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)",
               r'<link href="\2" color="#2f5fed">\1</link>', t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"<b>\1</b>", t)
    t = re.sub(r"<kbd>(.+?)</kbd>",
               r'<font face="Courier" size="8.6">[\1]</font>', t)
    t = re.sub(r"</?(?:details|summary)>", "", t)
    return t.strip()


def code_block(lines):
    body = "\n".join(lines) or " "
    inner = Preformatted(body, S["code"])
    tbl = Table([[inner]], colWidths=[165 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return [Spacer(1, 3), tbl, Spacer(1, 9)]


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def make_table(rows):
    header, *body = rows
    ncols = max(len(r) for r in rows)

    def pad(r):
        return r + [""] * (ncols - len(r))

    data = [[Paragraph(inline(c), S["cellhead"]) for c in pad(header)]]
    for r in body:
        data.append([Paragraph(inline(c), S["cell"]) for c in pad(r)])

    total = 165 * mm
    # Give the first column a little less room when there are only two: those are
    # the "Symptom | Fix" and "Check | What it catches" tables, where the
    # explanation needs the space.
    widths = [total * 0.34] + [total * 0.66 / (ncols - 1)] * (ncols - 1) if ncols > 1 else [total]

    tbl = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TABLE_HEAD),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return [Spacer(1, 4), tbl, Spacer(1, 10)]


def flush_list(items, ordered):
    if not items:
        return []
    flow = ListFlowable(
        [ListItem(Paragraph(inline(i), S["li"]), leftIndent=14) for i in items],
        bulletType="1" if ordered else "bullet",
        bulletFontSize=9,
        bulletColor=ACCENT if ordered else MUTED,
        leftIndent=16,
        spaceAfter=8,
    )
    return [flow]


BULLET_RE = re.compile(r"^\s*[-*]\s+(.*)")
ORDERED_RE = re.compile(r"^\s*\d+\.\s+(.*)")


def render(md, skip_h1=True):
    """Markdown text -> list of flowables."""
    out = []
    lines = md.split("\n")

    list_items, list_ordered = [], False
    table_rows = []
    i = 0

    def close_list():
        nonlocal list_items
        out.extend(flush_list(list_items, list_ordered))
        list_items = []

    def close_table():
        nonlocal table_rows
        if table_rows:
            out.extend(make_table(table_rows))
            table_rows = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Fenced code
        if stripped.startswith("```"):
            close_list(); close_table()
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.extend(code_block(buf))
            continue

        # Tables: a row of pipes, with the --- separator skipped
        if stripped.startswith("|") and stripped.count("|") >= 2:
            close_list()
            if not re.fullmatch(r"[|\s:-]+", stripped):
                table_rows.append(split_row(stripped))
            i += 1
            continue
        close_table()

        if not stripped:
            close_list()
            i += 1
            continue

        # Headings
        m = re.match(r"^(#{1,4})\s+(.*)", stripped)
        if m:
            close_list()
            level, text = len(m.group(1)), m.group(2)
            if level == 1 and skip_h1:
                i += 1
                continue
            key = {1: "h1", 2: "h1", 3: "h2", 4: "h3"}[level]
            out.append(Paragraph(inline(text), S[key]))
            if level <= 2:
                out.append(HRFlowable(width="100%", thickness=0.6, color=RULE,
                                      spaceBefore=2, spaceAfter=8))
            i += 1
            continue

        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
            close_list()
            out.append(Spacer(1, 4))
            out.append(HRFlowable(width="100%", thickness=0.6, color=RULE))
            out.append(Spacer(1, 8))
            i += 1
            continue

        # Blockquote — collected so a multi-line note renders as one block
        if stripped.startswith(">"):
            close_list()
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            text = " ".join(x for x in buf if x)
            cell = Paragraph(inline(text), S["quote"])
            tbl = Table([[cell]], colWidths=[165 * mm])
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fffaf1")),
                ("LINEBEFORE", (0, 0), (0, -1), 2.5, colors.HexColor("#d98c14")),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]))
            out.extend([Spacer(1, 3), tbl, Spacer(1, 9)])
            continue

        # Lists
        mb, mo = BULLET_RE.match(line), ORDERED_RE.match(line)
        if mb or mo:
            ordered = bool(mo)
            if list_items and ordered != list_ordered:
                close_list()
            list_ordered = ordered
            item = (mo or mb).group(1)
            # Fold continuation lines into the same bullet.
            i += 1
            while (i < len(lines) and lines[i].strip()
                   and not BULLET_RE.match(lines[i]) and not ORDERED_RE.match(lines[i])
                   and not lines[i].strip().startswith(("#", "|", ">", "```"))
                   and lines[i].startswith((" ", "\t"))):
                item += " " + lines[i].strip()
                i += 1
            list_items.append(item)
            continue

        close_list()

        # <summary> lines act as a small heading for the collapsed block
        msum = re.match(r"^<summary>(.*?)</summary>$", stripped)
        if msum:
            out.append(Paragraph(inline(msum.group(1)), S["h4"]))
            i += 1
            continue
        if stripped in ("<details>", "</details>"):
            i += 1
            continue

        # Paragraph: join until a blank line or a structural marker
        buf = [stripped]
        i += 1
        while (i < len(lines) and lines[i].strip()
               and not lines[i].strip().startswith(("#", "|", ">", "```", "---"))
               and not BULLET_RE.match(lines[i]) and not ORDERED_RE.match(lines[i])):
            buf.append(lines[i].strip())
            i += 1
        out.append(Paragraph(inline(" ".join(buf)), S["body"]))

    close_list()
    close_table()
    return out


def build():
    doc = BaseDocTemplate(
        str(OUT), pagesize=A4,
        leftMargin=22 * mm, rightMargin=22 * mm,
        topMargin=20 * mm, bottomMargin=18 * mm,
        title="BDD Test Generator — Handbook",
        author="BDD Test Generator",
        subject="Setup guide and full reference",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")

    def footer(canvas, d):
        canvas.saveState()
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.5)
        y = doc.bottomMargin - 6 * mm
        canvas.line(doc.leftMargin, y, doc.leftMargin + doc.width, y)
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(doc.leftMargin, y - 4.5 * mm, "BDD Test Generator — Handbook")
        canvas.drawRightString(doc.leftMargin + doc.width, y - 4.5 * mm,
                               f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=footer)])

    story = [
        Paragraph("BDD Test Generator", S["title"]),
        Paragraph(
            "Handbook — setup guide and full reference. Writes BDD test cases in Gherkin "
            "from a link to a page or a plain description, then lets you review, revise "
            "and export them. Runs entirely on your own machine.",
            S["subtitle"],
        ),
        HRFlowable(width="100%", thickness=1, color=ACCENT, spaceAfter=4),
    ]

    story.append(Paragraph("Part 1 — Setup guide", S["h1"]))
    story.append(Paragraph(
        "Start here. Everything you need to install it and generate your first test cases.",
        S["body"]))
    story.append(Spacer(1, 4))
    story += render(sanitize((ROOT / "SETUP.md").read_text(encoding="utf-8")))

    story.append(PageBreak())
    story.append(Paragraph("Part 2 — Full reference", S["h1"]))
    story.append(Paragraph(
        "How each part works, and the details behind the options.", S["body"]))
    story.append(Spacer(1, 4))
    story += render(sanitize((ROOT / "README.md").read_text(encoding="utf-8")))

    doc.build(story)
    print(f"Wrote {OUT.name} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    build()
