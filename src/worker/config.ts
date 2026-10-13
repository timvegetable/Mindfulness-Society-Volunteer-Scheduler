// The scheduler imports from the society's single WhenIsGood results page.
export const whenIsGoodSource = { endpoint: 'https://whenisgood.net/d7y3d5c/results/{resultId}', resultId: 'mx8t23j' };

export interface AppConfig {
  timeZone: string;
  displayIncrementMinutes: number;
  operatingHoursStart: string;
  operatingHoursEnd: string;
  oauthClientId: string;
  adminEmails: string[];
}

export const testConfig: AppConfig = {
  timeZone: 'America/New_York', displayIncrementMinutes: 30,
  operatingHoursStart: '09:00', operatingHoursEnd: '21:00',
  oauthClientId: 'test-client', adminEmails: ['admin@example.invalid'],
};
