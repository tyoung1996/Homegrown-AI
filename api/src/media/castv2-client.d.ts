// castv2-client ships no types; this is the slice of it the app uses
declare module 'castv2-client' {
  interface MediaStatus {
    playerState?: string;
    idleReason?: string;
    currentTime?: number;
    media?: { contentId?: string; duration?: number };
  }

  interface ReceiverSession {
    appId: string;
    displayName?: string;
    sessionId: string;
    transportId: string;
  }

  export class DefaultMediaReceiver {
    load(
      media: Record<string, unknown>,
      options: Record<string, unknown>,
      callback: (err: Error | null, status: MediaStatus) => void,
    ): void;
    getStatus(
      callback: (err: Error | null, status?: MediaStatus) => void,
    ): void;
    stop(callback: (err?: Error | null) => void): void;
    pause(callback: (err?: Error | null) => void): void;
    play(callback: (err?: Error | null) => void): void;
  }

  export class Client {
    connect(host: string, callback: () => void): void;
    launch(
      app: typeof DefaultMediaReceiver,
      callback: (err: Error | null, player: DefaultMediaReceiver) => void,
    ): void;
    getSessions(
      callback: (err: Error | null, sessions: ReceiverSession[]) => void,
    ): void;
    /** attach to an app that is already running, without restarting it */
    join(
      session: ReceiverSession,
      app: typeof DefaultMediaReceiver,
      callback: (err: Error | null, player: DefaultMediaReceiver) => void,
    ): void;
    setVolume(
      volume: { level?: number; muted?: boolean },
      callback: (err?: Error | null) => void,
    ): void;
    /** Quit the app on the receiver — stops playback and returns the TV to
     * its own home screen. */
    stop(
      app: DefaultMediaReceiver,
      callback: (err?: Error | null) => void,
    ): void;
    close(): void;
    on(event: 'error', handler: (err: Error) => void): void;
  }
}
