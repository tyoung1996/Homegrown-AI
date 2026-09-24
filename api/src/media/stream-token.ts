import { createHmac } from 'crypto';

/**
 * A link a TV can use, that nobody can guess.
 *
 * Anything that plays a url — a Chromecast, a TV's own player — cannot send
 * an Authorization header, so the permission has to travel in the link. This
 * is a signature over the item id using the server's own secret: it cannot
 * be worked out from outside, it is different for every film, and it gives
 * away nothing about anything else in the library.
 */
export function streamToken(itemId: string): string {
  const secret = process.env.JWT_SECRET ?? 'circuit-barn';
  return createHmac('sha256', secret)
    .update(`stream:${itemId}`)
    .digest('hex')
    .slice(0, 32);
}
