"""Synthetic meeting transcript generator for the real-Anthropic e2e tests.

Three goals:

  1. **Realistic content** — actual meeting-shaped material so faithfulness
     assertions ("did the model find the budget decision?") are
     meaningful. Random lorem ipsum produces empty summaries.
  2. **Duration scaling** — the same generator yields a 30-minute or a
     2-hour transcript by varying chunk count. Word density is held
     near a typical 2-speaker conversation rate (~140 wpm).
  3. **Embedded ground-truth markers** — known decisions, action items,
     and topics that we can grep for in the model's output. Keeps the
     faithfulness assertions narrow and falsifiable instead of
     subjective.

The transcript text follows the speaker-tagged form the runner expects
(`S0: ...\\nS1: ...`).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TranscriptFixture:
    """One generated meeting fixture.

    `transcript_text` is the speaker-tagged form. `expected_*` lists
    are ground-truth markers — substrings we expect the model's output
    to faithfully echo (case-insensitive). They aren't exact matches
    against the LLM's wording, just the load-bearing nouns/verbs.
    """

    transcript_text: str
    speaker_count: int
    expected_decisions: list[str]
    expected_action_items: list[str]
    expected_topics: list[str]
    word_count: int


# Each "block" represents roughly one minute of conversation at ~140
# wpm. Speakers alternate with realistic turn-taking and explicit
# decisions / action items embedded so the faithfulness assertions
# have something specific to find.
_BLOCKS: list[tuple[str, str]] = [
    (
        "S0",
        "Alright, let's get started. The main agenda today is the Q3 launch "
        "plan for the analytics dashboard. We need to align on scope, the "
        "engineering staffing, and the rollout timeline. I want to leave with "
        "clear next steps for everyone in the room.",
    ),
    (
        "S1",
        "Sounds good. Before we dive in, can we confirm whether marketing is "
        "joining? I sent them an invite but I haven't heard back. If they're "
        "not coming we should probably cover the messaging questions ourselves.",
    ),
    (
        "S0",
        "They're not joining today. We'll catch them up async. Let's start "
        "with scope. The original spec had three major features: cohort "
        "filtering, custom date ranges, and saved views. We agreed last week "
        "that saved views slips to Q4 because of the auth dependency.",
    ),
    (
        "S1",
        "Right. So Q3 is just cohort filtering and custom date ranges. I "
        "looked at the engineering estimates again. Cohort filtering is "
        "tracking at about three weeks of dev time. Custom date ranges is "
        "smaller, maybe a week and a half. We have buffer for QA.",
    ),
    (
        "S0",
        "Good. Decision: we're shipping cohort filtering and custom date "
        "ranges for Q3, with saved views deferred to Q4. I'll write that up "
        "and send it to the team after this meeting.",
    ),
    (
        "S1",
        "On staffing — we have two engineers free for the next six weeks. "
        "Priya is the obvious lead given she built the v1 dashboard. She "
        "knows the codebase and the pgvector embedding path. Should we "
        "assign her now?",
    ),
    (
        "S0",
        "Yes, let's do it. Action item: assign Priya as tech lead for the Q3 "
        "dashboard work, and pair her with Marcus on the cohort filtering "
        "piece. Marcus has been asking for more frontend exposure — this is "
        "a good fit. I'll talk to both of them this week.",
    ),
    (
        "S1",
        "Great. Timeline. If we kick off Monday and the estimate holds, we "
        "ship cohort filtering by mid-July and custom date ranges by end of "
        "July. That gives us August for QA, dogfooding, and a phased rollout.",
    ),
    (
        "S0",
        "I want to be careful about the rollout. We had problems with the "
        "v1 launch where the embedding query degraded for users with more "
        "than five hundred meetings. Let's commit to a feature flag rollout "
        "and we ramp it from one percent to fifty percent over two weeks "
        "while we watch the latency dashboards.",
    ),
    (
        "S1",
        "Agreed. Action item: I'll set up the LaunchDarkly flag and the "
        "Grafana panels for cohort filter latency before the dev work "
        "starts. That way we have the observability in place from day one. "
        "I'll have it ready by Friday.",
    ),
    (
        "S0",
        "Perfect. Last topic — pricing. Marketing wanted to know if cohort "
        "filtering bumps customers into a higher tier. My read is no. It's "
        "a feature improvement for existing dashboard users, not a new SKU. "
        "Anything blocking that view?",
    ),
    (
        "S1",
        "I don't think so. Custom date ranges is also clearly a quality-of-"
        "life improvement, not a new product surface. We can flag it to "
        "marketing async but I don't think we need to gate the launch on a "
        "pricing review.",
    ),
    (
        "S0",
        "Decision: cohort filtering and custom date ranges ship without a "
        "pricing tier change. I'll send a one-line note to marketing this "
        "afternoon so they can update the launch comms.",
    ),
    (
        "S1",
        "Anything else? Otherwise I'd like to grab the remaining few minutes "
        "to start drafting the cohort filtering tech spec.",
    ),
    (
        "S0",
        "Nothing from me. We're aligned on scope, staffing, timeline, "
        "rollout, and pricing. I'll send the recap email by end of day. "
        "Thanks everyone.",
    ),
]


def build_fixture(*, target_minutes: int) -> TranscriptFixture:
    """Generate a transcript of approximately `target_minutes` length.

    Loops the canonical 15-block conversation as many times as needed
    to hit the target word budget at ~140 wpm. Each loop pass tags
    the blocks with a "Round N" prefix so the LLM sees variation
    rather than literally identical content (which would tempt it
    into a single-paragraph reduction that ignores duration).

    Returns the fixture with ground-truth markers for faithfulness
    assertions.
    """
    if target_minutes < 1:
        raise ValueError("target_minutes must be >= 1")
    target_words = target_minutes * 140
    base_words = sum(len(text.split()) for _, text in _BLOCKS)
    rounds_needed = max(1, (target_words + base_words - 1) // base_words)

    lines: list[str] = []
    for round_idx in range(rounds_needed):
        round_label = f"(Round {round_idx + 1})" if rounds_needed > 1 else ""
        for speaker, text in _BLOCKS:
            tagged = (
                f"{speaker}: {round_label} {text}".rstrip()
                if round_label
                else f"{speaker}: {text}"
            )
            lines.append(tagged)

    transcript = "\n".join(lines)
    word_count = len(transcript.split())

    return TranscriptFixture(
        transcript_text=transcript,
        speaker_count=2,
        expected_decisions=[
            # The two explicit "Decision:" markers in the canonical
            # blocks. The LLM's wording will vary; we just want the
            # nouns to land somewhere in `decisions`.
            "cohort filtering",
            "saved views",
        ],
        expected_action_items=[
            "priya",
            "launchdarkly",
        ],
        expected_topics=[
            "scope",
            "staffing",
            "timeline",
            "rollout",
            "pricing",
        ],
        word_count=word_count,
    )
