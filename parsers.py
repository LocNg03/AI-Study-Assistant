"""
Parsers for LLM markdown output -> structured JSON.

The quiz and flashcard prompt templates ask Gemma for a specific markdown
shape, but small models wobble: extra blank lines, leading prose, missing
letters, occasional prose-style explanations. These parsers are deliberately
tolerant — split on anchors we can trust (Q\\d+:, ---), extract what matches,
skip what doesn't. Losing one malformed item out of ten is fine; rejecting
the whole payload is not.
"""

import re
from typing import TypedDict


class QuizQuestion(TypedDict):
    id: str
    type: str  # "mc"
    prompt: str
    choices: list[str]
    answer: int  # 0..3
    cite: str  # chunk id (c1, c2, ...) — assigned by caller, not the parser


class Flashcard(TypedDict):
    id: str
    front: str
    back: str
    cite: str
    tag: str


# Matches "Q1:", "Q12:", with optional leading space; captures question number.
_Q_SPLIT = re.compile(r"\n(?=Q\d+\s*[:.])")
# Matches a choice line: "A) text", "B. text", "(C) text", with trailing newline.
_CHOICE_RE = re.compile(r"^\s*\(?([A-D])[\)\.]?\s+(.+?)\s*$", re.MULTILINE)
# Matches "Answer: X" (case-insensitive, tolerates extra whitespace/punctuation).
_ANSWER_RE = re.compile(r"Answer\s*[:\-]\s*\(?([A-D])\)?", re.IGNORECASE)


def parse_quiz(text: str) -> list[QuizQuestion]:
    """Turn the LLM's quiz markdown into a list of structured questions.

    Drops any block that lacks 4 choices or a parseable answer — better to
    show 8 good questions than 10 with broken ones.
    """
    # Normalize line endings and prepend \n so the first "Q1:" is split like the rest.
    normalized = "\n" + text.replace("\r\n", "\n").strip()
    blocks = _Q_SPLIT.split(normalized)

    questions: list[QuizQuestion] = []
    for block in blocks:
        block = block.strip()
        if not block or not block.lstrip().lower().startswith("q"):
            continue

        # Question text = first line after "Q1:" up to the first blank line or "A)".
        m_prompt = re.match(
            r"Q\d+\s*[:.]\s*(.+?)(?=\n\s*\n|\n\s*\(?[A-D][\)\.])", block, re.DOTALL
        )
        if not m_prompt:
            continue
        prompt = " ".join(m_prompt.group(1).split())  # collapse whitespace

        # Collect up to 4 choices, keyed by letter so we can fill a 4-element list in order.
        choice_map: dict[str, str] = {}
        for m in _CHOICE_RE.finditer(block):
            letter, choice_text = m.group(1).upper(), m.group(2).strip()
            # Strip a trailing "Answer: X" if the LLM ran it into the last option.
            choice_text = re.split(
                r"\s*Answer\s*:", choice_text, maxsplit=1, flags=re.IGNORECASE
            )[0].strip()
            if letter not in choice_map and choice_text:
                choice_map[letter] = choice_text
        if len(choice_map) < 4:
            continue
        choices = [choice_map[k] for k in ("A", "B", "C", "D")]

        m_answer = _ANSWER_RE.search(block)
        if not m_answer:
            continue
        answer = ord(m_answer.group(1).upper()) - ord("A")

        questions.append(
            {
                "id": f"q{len(questions) + 1}",
                "type": "mc",
                "prompt": prompt,
                "choices": choices,
                "answer": answer,
                "cite": "",  # Filled in by the caller once chunks are assigned ids.
            }
        )

    return questions


# Matches "Front: ..." line (rest of line, non-greedy).
_FRONT_RE = re.compile(
    r"Front\s*:\s*(.+?)(?=\n\s*Back\s*:|\Z)", re.IGNORECASE | re.DOTALL
)
_BACK_RE = re.compile(
    r"Back\s*:\s*(.+?)(?=\n\s*---|\n\s*Front\s*:|\Z)", re.IGNORECASE | re.DOTALL
)


def parse_flashcards(text: str, tag: str = "") -> list[Flashcard]:
    """Turn the LLM's flashcard markdown into a list of structured cards.

    The template uses "---" separators, but models sometimes skip them or add
    extras. We rely on Front:/Back: as the real anchors and pair them up.
    """
    fronts = [m.group(1).strip() for m in _FRONT_RE.finditer(text)]
    backs = [m.group(1).strip() for m in _BACK_RE.finditer(text)]

    cards: list[Flashcard] = []
    for i, (front, back) in enumerate(zip(fronts, backs)):
        front = " ".join(front.split())
        back = " ".join(back.split())
        if not front or not back:
            continue
        cards.append(
            {
                "id": f"f{i + 1}",
                "front": front,
                "back": back,
                "cite": "",
                "tag": tag,
            }
        )
    return cards
