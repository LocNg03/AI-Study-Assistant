"""
Prompt Templates Module
=======================
Defines the instruction templates sent to the LLM. Each template has:
  - A system instruction (role + behavior rules)
  - Placeholders like {context} and {question} that get filled at runtime
  - An output format specification

PromptTemplate.from_template() creates a reusable template object.
Call template.format(context=..., question=...) to fill in the placeholders.
"""

from langchain_core.prompts import PromptTemplate

# Q&A: Answer a question using only the provided context from the user's notes.
# The instruction "If the answer is not in the context" prevents hallucination —
# the LLM won't make up answers from its general training data.
QA_TEMPLATE = PromptTemplate.from_template(
    """You are a helpful study assistant. Use the following context from the student's \
notes to answer their question. If the answer is not in the context, say \
"I couldn't find this in your notes."

Context:
{context}

Question: {question}

Answer:"""
)

# Quiz: Generate multiple-choice questions with 4 options each.
# {topic}, {num_questions}, {context} are filled in by generate_quiz() in rag.py.
# {topic} keeps the LLM focused: retrieval is topic-directed, but without this
# the generator would drift toward whatever the retrieved chunks cover most.
QUIZ_TEMPLATE = PromptTemplate.from_template(
    """You are a study assistant that creates quizzes. Based on the following context \
from the student's notes, generate {num_questions} multiple-choice questions about \
"{topic}" to test their understanding. Only use facts present in the context; if the \
context doesn't cover "{topic}" sufficiently, say so instead of inventing questions.

Format each question like this:
Q1: [Question text] \n 

A) [Option] \n

B) [Option] \n

C) [Option] \n

D) [Option] \n
Answer: [Correct letter]

Context:
{context}

Generate the quiz:"""
)

# Flashcards: Generate front/back pairs for studying key concepts.
# {topic}, {num_cards}, {context} are filled in by generate_flashcards() in rag.py.
FLASHCARD_TEMPLATE = PromptTemplate.from_template(
    """You are a study assistant that creates flashcards. Based on the following context \
from the student's notes, generate {num_cards} flashcards covering key concepts about \
"{topic}". Only use facts present in the context; if the context doesn't cover \
"{topic}" sufficiently, say so instead of inventing flashcards.

Format each flashcard like this:
---
Front: [Question or term]
Back: [Answer or definition]
---

Context:
{context}

Generate the flashcards:"""
)
