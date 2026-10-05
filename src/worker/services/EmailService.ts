import { Context, Effect, Layer } from 'effect';
import { AppError } from '../../shared/api/errors';
import type { Fetch } from './http';

export interface EmailMessage { to: string[]; subject: string; text: string }
export class EmailService extends Context.Service<EmailService, {
  readonly send: (message: EmailMessage) => Effect.Effect<void, AppError>;
}>()('EmailService') {}

export function makeResendEmail(config: { apiKey: string; from: string; fetch: Fetch }) {
  const fetcher = config.fetch;
  return EmailService.of({
    send: message => Effect.tryPromise({
      try: async signal => {
        if (!config.apiKey || !config.from || message.to.length === 0) throw new Error('Email is not configured');
        const response = await fetcher('https://api.resend.com/emails', {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: config.from, ...message }),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Email delivery failed');
      },
      catch: () => new AppError('INTERNAL_ERROR', 'Administrative notification could not be delivered.'),
    }),
  });
}

export const resendEmailLayer = (config: Parameters<typeof makeResendEmail>[0]) => Layer.succeed(EmailService, makeResendEmail(config));
