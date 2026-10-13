import { Effect, Layer } from 'effect';
import { AppError } from '../../shared/api/errors';
import { EmailService } from './EmailService';
import { readBoundedText, type Fetch } from './http';

interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  from: string;
  fetch: Fetch;
}

function base64(value: string): string {
  return btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(''));
}

const mailbox = (value: string) => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);

export function makeGmailEmail(config: GmailConfig) {
  const fetcher = config.fetch;
  return EmailService.of({
    send: message => Effect.tryPromise({
      try: async signal => {
        if (!config.clientId || !config.clientSecret || !config.refreshToken || !mailbox(config.from)
          || message.to.length === 0 || !message.to.every(mailbox) || /[\r\n]/.test(message.subject)) {
          throw new Error('Gmail is not configured or message headers are invalid');
        }
        const response = await fetcher('https://oauth2.googleapis.com/token', {
          method: 'POST', signal,
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
            refresh_token: config.refreshToken, grant_type: 'refresh_token' }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Gmail authorization failed'); }
        const token: unknown = JSON.parse(await readBoundedText(response, 16 * 1024));
        if (!token || typeof token !== 'object' || !('access_token' in token)
          || typeof token.access_token !== 'string' || !token.access_token) throw new Error('Invalid Gmail token');
        const mime = [
          `From: ${config.from}`, `To: ${message.to.join(', ')}`,
          `Subject: =?UTF-8?B?${base64(message.subject)}?=`,
          'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64', '',
          base64(message.text).match(/.{1,76}/g)?.join('\r\n') ?? '',
        ].join('\r\n');
        const sent = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: base64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }),
        });
        await sent.body?.cancel();
        if (!sent.ok) throw new Error('Gmail delivery failed');
      },
      catch: () => new AppError('INTERNAL_ERROR', 'Administrative notification could not be delivered.'),
    }),
  });
}

export const gmailEmailLayer = (config: GmailConfig) => Layer.succeed(EmailService, makeGmailEmail(config));
