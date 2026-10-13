import { Layer } from 'effect';
import { AuthService, makeGoogleAuth } from '../services/AuthService';
import { databaseLayer } from '../services/Database';
import { ClockLive } from '../services/Clock';
import { IdGeneratorLive } from '../services/IdGenerator';
import { resendEmailLayer } from '../services/EmailService';
import { gmailEmailLayer } from '../services/GmailService';
import { whenIsGoodLayer } from '../services/WhenIsGoodClient';
import { whenIsGoodSource, type AppConfig } from '../config';

export interface Bindings {
  DB: D1Database; ASSETS: Fetcher;
  TIME_ZONE: string; DISPLAY_INCREMENT_MINUTES: string; OPERATING_HOURS_START: string; OPERATING_HOURS_END: string;
  OAUTH_CLIENT_ID: string; ADMIN_EMAILS: string;
  EMAIL_API_KEY?: string; EMAIL_FROM: string;
  EMAIL_PROVIDER?: 'resend' | 'gmail';
  GMAIL_CLIENT_ID?: string; GMAIL_CLIENT_SECRET?: string; GMAIL_REFRESH_TOKEN?: string;
}

// Only public signing keys are cached between requests. Users/roles always come from D1.
const verifiers = new Map<string, ReturnType<typeof makeGoogleAuth>>();
export function liveLayer(env: Bindings) {
  let verifier = verifiers.get(env.OAUTH_CLIENT_ID);
  if (!verifier) {
    verifier = makeGoogleAuth({ audience: env.OAUTH_CLIENT_ID, fetch, now: () => Date.now() });
    verifiers.set(env.OAUTH_CLIENT_ID, verifier);
  }
  return Layer.mergeAll(
    databaseLayer(env.DB), Layer.succeed(AuthService, verifier), ClockLive, IdGeneratorLive,
    env.EMAIL_PROVIDER === 'gmail'
      ? gmailEmailLayer({ clientId: env.GMAIL_CLIENT_ID ?? '', clientSecret: env.GMAIL_CLIENT_SECRET ?? '',
        refreshToken: env.GMAIL_REFRESH_TOKEN ?? '', from: env.EMAIL_FROM, fetch })
      : resendEmailLayer({ apiKey: env.EMAIL_API_KEY ?? '', from: env.EMAIL_FROM, fetch }),
    whenIsGoodLayer({ endpoint: whenIsGoodSource.endpoint, fetch }),
  );
}

export function appConfig(env: Bindings): AppConfig {
  return { timeZone: env.TIME_ZONE, displayIncrementMinutes: Number(env.DISPLAY_INCREMENT_MINUTES),
    operatingHoursStart: env.OPERATING_HOURS_START, operatingHoursEnd: env.OPERATING_HOURS_END,
    oauthClientId: env.OAUTH_CLIENT_ID, adminEmails: env.ADMIN_EMAILS.split(',').map((email) => email.trim()).filter(Boolean) };
}
