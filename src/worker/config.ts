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
