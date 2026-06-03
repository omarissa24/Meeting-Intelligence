"""LLM prompts for the LangGraph summarisation pipeline.

Three pieces:

1. `SYSTEM_PROMPT` — the FR-3.08 hallucination guard. Same text for
   incremental and reduce nodes; the variation is in the user message.
2. `INCREMENTAL_PROMPT_TEMPLATE` — wraps a single chunk; produces a
   plain-text condensation that the reduce node can stitch.
3. `REDUCE_PROMPT_TEMPLATE` — emits the final SummaryPayload via the
   forced `record_summary` tool.

Kept as plain f-string templates rather than Jinja — the pipeline has
no need for anything beyond simple substitution.
"""

from __future__ import annotations

SYSTEM_PROMPT = (
    "You are a meticulous meeting analyst. Your job is to produce "
    "faithful, evidence-bound summaries of meeting transcripts.\n"
    "\n"
    "Hard rules:\n"
    "  1. Only use information present in the transcript. Never invent "
    "decisions, action items, owners, deadlines, or topics that were "
    "not actually discussed.\n"
    "  2. If no decisions were made, return decisions=[]. Do NOT "
    "fabricate a decision to fill the section.\n"
    "  3. Action items must be concrete next steps that were actually "
    "stated. Do not derive speculative tasks from general discussion.\n"
    "  4. When an owner or deadline is unclear, leave it null. Do not "
    "guess. The UI surfaces \"Unassigned\" and \"No deadline set\" for "
    "missing values — that is the correct outcome when the transcript "
    "is silent.\n"
    "  5. Speakers in the transcript are labelled `S0:`, `S1:`, etc. "
    "Only refer to people by name when the transcript explicitly maps "
    "a speaker label to a name.\n"
    "  6. Write the prose summary in clear, professional sentences — "
    "not bullet fragments — and keep it focused on what was decided "
    "or discussed substantively."
)


INCREMENTAL_PROMPT_TEMPLATE = (
    "Below is a chunk of a meeting transcript (chunk {chunk_index} of "
    "{chunk_total}). Produce a faithful 4-6 sentence condensation of "
    "what was discussed in THIS chunk only. List any decisions and "
    "action items as plain text bullets at the end, or write \"None\" "
    "if none.\n"
    "\n"
    "TRANSCRIPT CHUNK:\n"
    "{chunk_text}\n"
    "\n"
    "Output the condensation as plain text. Do not invent content."
)


REDUCE_PROMPT_TEMPLATE = (
    "You will produce the final structured summary by calling the "
    "`record_summary` tool — do not respond in plain text.\n"
    "\n"
    "{source_label} of the meeting follows below. Synthesize a single "
    "summary, decisions list, action items list, and topics list. "
    "Apply all hard rules from the system prompt — especially: do not "
    "invent decisions or action items; leave owner/deadline null when "
    "not stated.\n"
    "\n"
    "{source_body}"
)


# Used as the {source_label} when reducing intermediate chunk
# summaries. Distinct labels keep the model oriented vs single-pass.
REDUCE_FROM_CHUNK_SUMMARIES_LABEL = (
    "Below are sequential per-chunk condensations"
)
REDUCE_FROM_FULL_TRANSCRIPT_LABEL = "The full transcript"


# Words below this threshold trigger the FR-3.09 too-short branch.
TOO_SHORT_WORD_THRESHOLD = 50
