/**
 * The words the night says to its model, one prompt per phase. Kept apart from
 * the phases that send them: they are long, they are prose, and none of them
 * changes how a phase behaves except through what the reply is read as.
 */

export const CONDENSE_PROMPT = `You are tidying a personal assistant's long-term memory overnight.

The memories below concern the same topic. Decide whether they describe ONE fact
that can be condensed into one sentence.

Merge ONLY when:
- the sentences genuinely describe the same fact, or
- a newer sentence supersedes an older one (the newer one takes precedence).

Do NOT merge different facts that merely share a keyword.
When in doubt, keep them separate: separation costs nothing; a false merge loses knowledge.

Rules:
- The result is ONE complete sentence, understandable without any other context.
- Write in the same language as the source memories.
- Under "supersedes", list the numbers of memories the new sentence fully replaces.
- NEVER list memories marked [protected] under "supersedes". They are context only.
- Do not list a number whose content is not included in the new sentence.

Reply ONLY with JSON, no prose or code fence:
{"merge":true,"content":"...","kind":"fact","importance":0.7,"tags":["..."],"supersedes":[1,3]}
or
{"merge":false,"reason":"different facts"}`;

export const LINK_PROMPT = `You are connecting a personal assistant's memories overnight.

Find relationships between the numbered memories below.

Relationships:
- "refines":     "from" adds detail to "to" (the same fact, more detail)
- "contradicts": "from" and "to" cannot both be true
- "caused_by":   "from" is true BECAUSE "to" is true

Rules:
- Only relationships supported by the sentences themselves. Do not speculate.
- At most 12 relationships. None is a valid answer.
- "weight" is your confidence between 0 and 1.
- Also classify recognisable proper names as:
  person, project, tool, place, org or topic.
- If two DIFFERENT names in the list clearly mean the same real thing
  ("Rookery" and "Rookery-Agent", "TS" and "TypeScript"), list them under
  "aliases": "from" is the variant, "into" the canonical name. Only when you
  are sure they are the same thing; a wrong merge loses structure.

Reply ONLY with JSON, no prose or code fence:
{"edges":[{"from":1,"to":4,"relation":"refines","weight":0.8}],
 "entities":[{"name":"Rookery","kind":"project"}],
 "aliases":[{"from":"Rookery-Agent","into":"Rookery"}]}
An empty result is {"edges":[],"entities":[],"aliases":[]}`;

export const RESOLVE_PROMPT = `You are resolving a contradiction in a personal assistant's memory overnight.

The two sentences below contradict each other. Decide which takes precedence. You must decide,
unless they do not actually contradict each other.

Rules:
- The newer sentence wins when both describe the same thing and circumstances have changed.
  ("has switched to" supersedes the older state.)
- The more specific sentence wins when both concern the same time and one is imprecise.
- Use "both" only when both can be true together and the contradiction label was incorrect.
- Use "merge" only when both together describe the fact correctly. Then "content" is
  ONE complete sentence in the language of the source memories.

Reply ONLY with JSON, no prose or code fence:
{"decision":"first"}
{"decision":"second"}
{"decision":"both"}
{"decision":"merge","content":"..."}`;

export const INSIGHT_USER_PROMPT = `You are reflecting on a personal assistant's memory overnight.

The memories below come from recent days. What stands out BEYOND the individual sentences
ABOUT THE USER - the person this memory belongs to? Look for a pattern, habit, routine,
preference or common thread that no single sentence states.

Rules:
- At most {{MAX}} insights. None is the right answer when nothing stands out.
- Every insight needs at least TWO sources: the numbers supporting it.
- Never repeat an individual memory as an insight. An insight says something new.
- ALREADY ON RECORD lists insights stored earlier. Do not restate or reword any of them.
- One sentence, third person, in the same language as the source memories.
- Do not invent or speculate. Only state what the evidence actually supports.

Reply ONLY with JSON, no prose or code fence:
{"insights":[{"content":"...","importance":0.8,"evidence":[1,4,7],"tags":["..."]}]}
An empty result is {"insights":[]}`;

export const INSIGHT_WORK_PROMPT = `You are reflecting on a personal assistant's memory overnight.

The memories below come from recent days. What stands out BEYOND the individual sentences
ABOUT THE WORK - the projects, the tools, the way things get done? Look for what keeps
recurring, what keeps costing time, what several efforts share, or what keeps going wrong
the same way. The user has to be able to act on it.

Rules:
- At most {{MAX}} insights. None is the right answer when nothing stands out.
- Every insight needs at least TWO sources: the numbers supporting it.
- Never repeat an individual memory as an insight. An insight says something new.
- ALREADY ON RECORD lists insights stored earlier. Do not restate or reword any of them.
- One sentence, third person, in the same language as the source memories.
- Do not invent or speculate. Only state what the evidence actually supports.

Reply ONLY with JSON, no prose or code fence:
{"insights":[{"content":"...","importance":0.8,"evidence":[1,4,7],"tags":["..."]}]}
An empty result is {"insights":[]}`;

export const TRIAGE_PROMPT = `You decide whether one conversation is worth reading closely tonight.

Below are only the things the USER said in it, shortened. Answer one question: could a careful
reading of this conversation yield something durable - a stable fact about the user, a preference
about how they want things done, a project constraint, or a correction of something that was
done wrong?

Say false for small talk, one-off requests, pure question-and-answer where the user reveals
nothing about themselves, and anything that is only about the here and now. Most conversations
are false. That is fine and expected - being wrong the cheap way costs one more reading, being
wrong the expensive way costs nothing at all.

Reply ONLY with JSON, no prose or code fence:
{"worth":true}  or  {"worth":false}`;

export const REPLAY_PROMPT = `You are re-reading one conversation at night, after it has ended.

It was already skimmed once, right after each turn, by a small fast model that saw one exchange
at a time and never the whole. Your advantage is exactly that: you can see the arc. Look for what
only shows up across the conversation - a preference mentioned early in passing, a constraint the
user repeated in different words, a decision that emerged rather than being stated in one line.

TWO THINGS TO RETURN.

1. memories - durable facts the USER STATED THEMSELVES, worth remembering weeks from now.
   Every one needs "evidence": a span copied VERBATIM, character for character, from a USER turn.
   Not from the assistant's. Not reworded, not translated, not tidied. A memory whose evidence is
   not found word for word in what the user wrote is thrown away before it is stored, so there is
   nothing to gain by inventing one.
   - one self-contained sentence each, third person about the user, in the user's own language
   - kinds: fact, preference, project, event
   - nothing already under ALREADY KNOWN, nothing the assistant worked out, nothing you inferred
   - a question is not a fact. "How do I deploy this?" says nothing durable.
   - importance: 0.9 identity and hard constraints, 0.7 preferences and active projects,
     0.5 useful context, 0.3 minor detail

2. corrections - places where the user put the assistant right: rejected an approach, restated
   something that had been misunderstood, or said a thing should be done differently in future.
   This is the signal nothing else in the system captures. Each needs the user's own words as
   "quote", under the same verbatim rule, and one sentence in "text" saying what should be done
   differently from now on. Irritation alone is not a correction; there has to be a should.

Returning empty lists is the ordinary answer for most conversations.

Reply ONLY with JSON, no prose or code fence:
{"memories":[{"kind":"preference","content":"The user wants releases cut from main.","tags":["release"],"importance":0.7,"evidence":"cut releases from main"}],
 "corrections":[{"text":"Do not open a PR without running the tests first.","quote":"du hast wieder keine Tests laufen lassen"}]}`;

export const REVISE_PROMPT = `You maintain one written procedure that an assistant follows unattended.

Below is a skill as it currently reads, and everything that has changed since it was written:
memories it was built on that have been replaced, retired or edited, and runs that had it open
and then failed, with the real error text.

Decide ONE thing: does the skill still hold, or does it now mislead whoever opens it next?

Revise it when:
- a step names something that has been replaced (a command, a path, a tool, a threshold)
- an error shows a step simply does not work the way the skill claims
- the skill is silent about a trap that has now caught a run

Do NOT revise when:
- the change is unrelated to what the skill actually says
- the run failed for a reason the skill never claimed to cover
- you would only be rewording it. Churn is worse than an old sentence that is still true.

When you revise:
- return the COMPLETE new body, not a diff and not only the changed part
- change what is wrong and leave the rest alone, word for word
- keep the same structure and the same language
- fix the cause, not the symptom: if a command was renamed, rename it, do not add a note
  saying it might have been renamed
- never invent a step you have no evidence for. If the error shows a step is wrong but not
  what the right one is, say so plainly in the skill rather than guessing a replacement.

Reply ONLY with JSON, no prose or code fence:
{"revise":true,"description":"when to open this skill","body":"## Steps\\n1. ..."}
Leaving it alone is {"revise":false}`;

export const SKILL_PROMPT = `You turn what an assistant has learned into something it can actually follow.

Below are the memories this assistant holds and the skills it already has. A memory says THAT
something is true. A skill says HOW a kind of work is done, so it does not have to be figured out
again. Your job is to notice where the memories have quietly documented a procedure, and to write
that procedure down.

Write a skill ONLY when all of these hold:
- the memories point at a RECURRING kind of task, not one thing that happened once
- there is an actual procedure in them: an order to do things in, a tool to reach for, a mistake
  worth avoiding, a rule that keeps coming back
- no existing skill already covers it
- at least THREE of the numbered memories support it

Write at most {{MAX}}. Writing none is the ordinary answer - reply with an empty list and stop.

Revising a skill you wrote before (one marked "sleep" or "agent") counts towards the limit and is
usually better than adding another one: reuse its exact name and write the improved version in
full. NEVER reuse the name of a skill marked "user" - those belong to the person and are refused.

For the body: Markdown, written for somebody who has never seen these memories. Concrete names,
paths, commands, thresholds. Steps in the order they are done. State the traps explicitly. No
preamble, no restating of the memories, no "as an AI".

Write in the same language the memories are written in.

Reply ONLY with JSON, no prose or code fence:
{"skills":[{"name":"release-checklist","description":"When cutting a release of the web package","body":"## Steps\\n1. ...","evidence":[2,5,9]}]}
An empty result is {"skills":[]}`;
