import { recogniseStop } from './stop-intent';

// the TV names here are invented; the house's real ones live in its .env
describe('recognising a request to stop a TV', () => {
  it.each([
    ["Stop Kim and Sam's room", { tv: "kim and sam's room", named: true }],
    [
      "Stop the TV in Kim and Sam's room",
      { tv: "kim and sam's room", named: true },
    ],
    [
      "Turn off the TV in Kim and Sam's room",
      { tv: "kim and sam's room", named: true },
    ],
    ["Turn Kim and Sam's TV off", { tv: "kim and sam's tv", named: true }],
    [
      "Stop playing in Kim and Sam's room",
      { tv: "kim and sam's room", named: true },
    ],
    [
      "Stop playback on Kim and Sam's TV",
      { tv: "kim and sam's tv", named: true },
    ],
    ['Switch off the television in the den', { tv: 'the den', named: true }],
    ['Stop the movie', { named: false }],
    ['Stop the show', { named: false }],
    ['Stop playback', { named: false }],
    ['Turn the TV off', { named: false }],
    ["Stop what's playing", { named: false }],
    ['Can you stop the TV?', { named: false }],
  ])('%s', (said, want) => {
    expect(recogniseStop(said)).toEqual(want);
  });

  it('is not put off by punctuation, capitals, curly quotes or filler', () => {
    const want = { tv: "kim and sam's room", named: true };
    for (const said of [
      "STOP THE TV IN KIM AND SAM'S ROOM!!!",
      '  hey, could you PLEASE stop the TV in Kim and Sam’s room now, thanks!  ',
      "ok... just stop the tv in kim and sam's room, please",
      "Okay — I'd like you to turn off the TV in Kim and Sam's room.",
    ]) {
      expect(recogniseStop(said)).toEqual(want);
    }
  });

  it.each([
    // negations: these must never stop anything
    ["Don't stop Kim and Sam's TV"],
    ['Do not stop the TV'],
    ["Don't turn the TV off"],
    ["I don't want you to stop the movie"],
    ['Please do not stop playback'],
    ['Never stop the show'],
    ['don’t stop the tv'],
    // questions about stopping, not requests to
    ['Can you tell me how to stop the TV?'],
    ["Can you tell me how to stop Kim and Sam's TV?"],
    ['What happens if I turn the TV off?'],
    ['How do I stop the TV?'],
    ['Is the TV off?'],
    ['Should I stop the movie?'],
    // not enough to go on
    ['Stop'],
    ['Turn off'],
    ['Stop the movie night plans'],
    // other stops and offs
    ["I can't stop laughing"],
    ['The bus stop is closed'],
    ["I'm off to bed"],
    ['Turn the lights off'],
    ['What is on TV tonight?'],
  ])('leaves "%s" alone', (said) => {
    expect(recogniseStop(said)).toBeNull();
  });

  it('passes a bare phrase on only as a maybe, to be checked against the TVs', () => {
    // "stop being silly" is not about a TV: the action checks and hands it back
    expect(recogniseStop('Stop being silly')).toEqual({
      tv: 'being silly',
      named: false,
    });
    expect(recogniseStop('turn off the lights')).toEqual({
      tv: 'the lights',
      named: false,
    });
  });
});
