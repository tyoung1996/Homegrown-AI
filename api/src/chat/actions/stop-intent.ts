// Is this message, plainly and without doubt, someone telling a TV to stop?
// Pure text work: no network, so every phrasing is testable. Anything short
// of a clear instruction is left to the conversation.

export interface StopIntent {
  /** the TV as they said it, if they said one: "emmy and ty's room" */
  tv?: string;
  /** true when it was plainly a TV they named ("the TV in the den", "on the
   * den", "den TV"); false for a bare name after the verb, which only counts
   * if it turns out to be a TV */
  named: boolean;
}

// any of these anywhere and it is not an instruction to stop
const NEGATION =
  /\b(don't|dont|do not|does not|doesn't|never|not|no|won't|wont|shouldn't|mustn't|can't|cant|cannot|without|stop stopping)\b/;
// a question about stopping, not a request to
const QUESTION =
  /^(how|what|what's|whats|why|when|where|which|who|whose|is|are|was|does|did|do|should|shall|if|whether)\b|\b(how (do|can|would|to)|how to|what happens|what if|tell me|explain|show me|is it ok|would it|will it|if i)\b/;

const LEADING = [
  /^(hey|hi|hello|ok|okay|um|uh|er|so|right|alright|oh|yo)\b ?/,
  /^(please|kindly|just|quickly|go ahead and) /,
  /^(can|could|would|will) you (please |just )?/,
  /^(i want|i'd like|id like|i would like|i need) you to /,
];
const TRAILING =
  / (please|now|right now|thanks|thank you|thx|for me|asap|straight away|immediately)$/;

const THING =
  /^(?:the |this |that |my |our )?(tv|television|telly|screen|movie|film|show|episode|video|cartoon|programme|program)\b ?/;
const PLAYING =
  /^(playing|the playback|playback|streaming|casting|what's playing|whats playing|what is playing|what's on|whats on)\b ?/;
const WHERE = /^(?:on|in|at|from) (.+)$/;
const TV_WORD = /\b(tv|television|telly|screen|room)\b/;

/** lower case, straight apostrophes, no punctuation, single spaces */
export function tidy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function recogniseStop(message: string): StopIntent | null {
  let s = tidy(message);
  if (!s || NEGATION.test(s) || QUESTION.test(s)) return null;

  // "hey, could you please ... now thanks" -> "..."
  for (let changed = true; changed;) {
    changed = false;
    for (const re of LEADING) {
      const next = s.replace(re, '');
      if (next !== s) {
        s = next.trim();
        changed = true;
      }
    }
    const next = s.replace(TRAILING, '');
    if (next !== s) {
      s = next.trim();
      changed = true;
    }
  }

  // the verb: stop / turn off X / turn X off
  let rest: string;
  let offAtEnd = false;
  let m = /^stop\b ?(.*)$/.exec(s);
  if (m) rest = m[1];
  else if ((m = /^(?:turn|switch|shut) off\b ?(.*)$/.exec(s))) rest = m[1];
  else if ((m = /^(?:turn|switch|shut) (.+) off$/.exec(s))) {
    rest = m[1];
    offAtEnd = true;
  } else return null;
  rest = rest.trim();

  // what is being stopped: the TV, the film, the playback...
  let thing = false;
  for (const re of [THING, PLAYING]) {
    const t = re.exec(rest);
    if (t) {
      thing = true;
      rest = rest.slice(t[0].length).trim();
      break;
    }
  }
  if (!rest) return thing ? { named: false } : null; // "stop" alone is not enough

  // ...and where: "in the den", "on emmy and ty's tv"
  const where = WHERE.exec(rest);
  if (where) return { tv: where[1].trim(), named: true };
  if (thing) return null; // "stop the movie something" — not clear enough

  // a bare name: "stop emmy and ty's room", "turn emmy and ty's tv off"
  if (offAtEnd && !TV_WORD.test(rest)) return null; // "turn the lights off"
  return { tv: rest, named: TV_WORD.test(rest) };
}
