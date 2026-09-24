import { Inject, Injectable, Logger } from '@nestjs/common';

/** Who asked, where, and exactly what they said. */
export interface ActionContext {
  userId: string;
  conversationId: string;
  message: string;
}

/** What happened, in words written from the result — never from a model. */
export interface ActionReply {
  /** which action handled it, e.g. "stop" */
  action: string;
  /** the result the reply was written from, e.g. "stopped", "unreachable" */
  outcome: string;
  /** the sentence the person sees */
  reply: string;
}

/**
 * Something the house does physically — stop a TV today; pause or resume
 * one later — that must never be left to the chat model to decide or to
 * describe. An action recognises its own requests with high confidence,
 * carries them out, checks they happened, and says what actually did.
 */
export interface VerifiedAction<Intent = unknown> {
  readonly name: string;
  /** Is this message plainly a request for this action? Null leaves it to
   * the conversation, as does anything short of high confidence. */
  recognise(message: string): Intent | null;
  /** Do it and report what really happened. Null hands the message back
   * to the conversation after all (it turned out not to be one). */
  perform(ctx: ActionContext, intent: Intent): Promise<ActionReply | null>;
}

export const VERIFIED_ACTIONS = Symbol('VERIFIED_ACTIONS');

/** Tries each registered action before a message reaches the model. */
@Injectable()
export class VerifiedActions {
  private log = new Logger('Actions');

  constructor(
    @Inject(VERIFIED_ACTIONS) private readonly actions: VerifiedAction[],
  ) {}

  async handle(ctx: ActionContext): Promise<ActionReply | null> {
    for (const action of this.actions) {
      const intent = action.recognise(ctx.message);
      if (intent === null) continue;
      const done = await action.perform(ctx, intent);
      if (!done) continue;
      this.log.log(`${done.action}: ${done.outcome}`);
      return done;
    }
    return null;
  }
}
