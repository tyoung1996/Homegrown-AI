import { streamToken } from './stream-token';

describe('the link a TV is given for a film', () => {
  const ORIGINAL = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.JWT_SECRET = 'a-test-secret';
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL;
  });

  it('is the same every time for the same film', () => {
    expect(streamToken('abc123')).toBe(streamToken('abc123'));
  });

  it('is different for every film, so one link opens one film', () => {
    expect(streamToken('abc123')).not.toBe(streamToken('abc124'));
  });

  it('cannot be produced without the server secret', () => {
    const mine = streamToken('abc123');
    process.env.JWT_SECRET = 'someone-elses-secret';
    expect(streamToken('abc123')).not.toBe(mine);
  });

  it('gives nothing away about the film or the library', () => {
    const token = streamToken('abc123');
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(token).not.toContain('abc123');
  });
});
