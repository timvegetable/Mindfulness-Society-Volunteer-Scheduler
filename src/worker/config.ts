import { applicationTimeZone } from '../shared/domain/models';

// The scheduler imports from the society's single WhenIsGood results page.
export const whenIsGoodSource = { endpoint: 'https://whenisgood.net/d7y3d5c/results/{resultId}', resultId: 'mx8t23j' };

export interface AppConfig {
  timeZone: typeof applicationTimeZone;
  displayIncrementMinutes: number;
  operatingHoursStart: string;
  operatingHoursEnd: string;
  oauthClientId: string;
  adminEmails: string[];
  calendarTokenKey?: string;
}

export const testConfig: AppConfig = {
  timeZone: applicationTimeZone, displayIncrementMinutes: 30,
  operatingHoursStart: '09:00', operatingHoursEnd: '21:00',
  oauthClientId: 'test-client', adminEmails: ['admin@example.invalid'],
  calendarTokenKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
