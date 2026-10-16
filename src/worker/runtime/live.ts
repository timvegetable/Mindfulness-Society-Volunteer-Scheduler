import { Context, Effect } from 'effect';
import { applicationTimeZone } from '../../shared/domain/models';
import { AuthService, makeGoogleAuth } from '../services/AuthService';
import { Database, makeDatabase } from '../services/Database';
import { Clock } from '../services/Clock';
import { IdGenerator } from '../services/IdGenerator';
import { EmailService, makeResendEmail } from '../services/EmailService';
import { makeGmailEmail } from '../services/GmailService';
import { WhenIsGoodClient, makeWhenIsGoodClient } from '../services/WhenIsGoodClient';
import { whenIsGoodSource, type AppConfig } from '../config';

export interface Bindings {
  DB: D1Database; ASSETS: Fetcher;
  TIME_ZONE: string; DISPLAY_INCREMENT_MINUTES: string; OPERATING_HOURS_START: string; OPERATING_HOURS_END: string;
  OAUTH_CLIENT_ID: string; ADMIN_EMAILS: string;
  EMAIL_API_KEY?: string; EMAIL_FROM: string;
  EMAIL_PROVIDER?: 'resend' | 'gmail';
  GMAIL_CLIENT_ID?: string; GMAIL_CLIENT_SECRET?: string; GMAIL_REFRESH_TOKEN?: string;
}

// Authentication caches only public signing keys. Users/roles always come from D1.
const verifiers = new Map<string, ReturnType<typeof makeGoogleAuth>>();
export function liveServices(env: Bindings) {
  let verifier = verifiers.get(env.OAUTH_CLIENT_ID);
  if (!verifier) {
    verifier = makeGoogleAuth({ audience: env.OAUTH_CLIENT_ID, fetch, now: () => Date.now() });
    verifiers.set(env.OAUTH_CLIENT_ID, verifier);
  }
  return Context.mergeAll(
    synchronizationServices(env), Context.make(AuthService, verifier),
    Context.make(EmailService, env.EMAIL_PROVIDER === 'gmail'
      ? makeGmailEmail({ clientId: env.GMAIL_CLIENT_ID ?? '', clientSecret: env.GMAIL_CLIENT_SECRET ?? '',
        refreshToken: env.GMAIL_REFRESH_TOKEN ?? '', from: env.EMAIL_FROM, fetch })
      : makeResendEmail({ apiKey: env.EMAIL_API_KEY ?? '', from: env.EMAIL_FROM, fetch })),
  );
}

/** These services own no resources, so a request needs no layer acquisition/scope. */
const systemServices = Context.merge(
  Context.make(Clock, { now: Effect.sync(() => new Date()) }),
  Context.make(IdGenerator, { next: Effect.sync(() => crypto.randomUUID()) }),
);

/** The scheduled runtime has no Google authentication or email capability. */
export function synchronizationServices(env: Bindings) {
  return Context.mergeAll(systemServices, Context.make(Database, makeDatabase(env.DB)),
    Context.make(WhenIsGoodClient, makeWhenIsGoodClient({ endpoint: whenIsGoodSource.endpoint, fetch })));
}

export function appConfig(env: Bindings): AppConfig {
  return { timeZone: applicationTimeZone, displayIncrementMinutes: Number(env.DISPLAY_INCREMENT_MINUTES),
    operatingHoursStart: env.OPERATING_HOURS_START, operatingHoursEnd: env.OPERATING_HOURS_END,
    oauthClientId: env.OAUTH_CLIENT_ID, adminEmails: env.ADMIN_EMAILS.split(',').map((email) => email.trim()).filter(Boolean) };
}
