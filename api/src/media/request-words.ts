// How a request is getting on, said to the family. No source names, no
// paths, no errors — those stay in the admin note.

import { MediaKind, MediaStatus } from '@prisma/client';

interface Asked {
  kind: MediaKind;
  title: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** "Harbour Lights", "Night Shift Season 2", "Night Shift Season 3 Episode 4" */
export function spokenRequest(r: Asked): string {
  if (r.kind === MediaKind.SEASON && r.seasonNumber != null) {
    return `${r.title} Season ${r.seasonNumber}`;
  }
  if (r.kind === MediaKind.EPISODE && r.seasonNumber != null) {
    return `${r.title} Season ${r.seasonNumber} Episode ${r.episodeNumber ?? '?'}`;
  }
  return r.title;
}

/**
 * One sentence about where a request stands. A percentage is only ever
 * given when a source measured one; otherwise just the stage.
 */
export function requestLine(
  r: Asked & { status: MediaStatus; progress: number | null },
): string {
  const it = spokenRequest(r);
  switch (r.status) {
    case MediaStatus.REQUESTED:
      return `${it} is on the list.`;
    case MediaStatus.SEARCHING:
      return `Looking for ${it}.`;
    case MediaStatus.ACQUIRING:
      if (r.progress == null) return `${it} is being added to the library.`;
      return r.progress < 1
        ? `${it} is downloading — it's only just started.`
        : `${it} is downloading — about ${Math.min(99, Math.floor(r.progress))}% complete.`;
    case MediaStatus.IMPORTING:
      return `${it} is almost ready.`;
    case MediaStatus.AVAILABLE:
      return `${it} is ready to watch.`;
    case MediaStatus.UNAVAILABLE:
      return `I couldn't add ${it}.`;
    case MediaStatus.CANCELLED:
      return `${it} was taken off the list.`;
  }
}
